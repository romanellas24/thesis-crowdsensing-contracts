import {ethers} from "hardhat";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {PrivacyFirstContract} from "../typechain-types";
import cipher from "./cipher";
import {expect} from "chai";

export default {
    getPublicKey: async (user: HardhatEthersSigner) => {
        // messaggio fisso
        const messageHash = ethers.id("dummy"); // keccak256("dummy")
        const messageHashBytes = ethers.getBytes(messageHash);

        // firma del messaggio
        const signature = await user.signMessage(messageHashBytes);

        // ricavo della chiave pubblica
        const pubKey = ethers.SigningKey.recoverPublicKey(messageHashBytes, signature);

        return pubKey;
    },

    setupOwnerPrivacy: async (owner: HardhatEthersSigner, contract: PrivacyFirstContract, ownerKeys: { publicKey: string, privateKey: string }) => {
        const encryptionKeys = cipher.generateEncryptionKeys();
        // @ts-ignore
        contract.connect(owner).on("SenderEnrolledEvent", (sender: string, key: string, event: any) => {
            const bundle = JSON.parse(key);
            const senderPublicKey = cipher.decryptStringHybrid(ownerKeys.privateKey, bundle)
            const encryptionKeyHidden = JSON.stringify(cipher.encryptStringHybrid(senderPublicKey, encryptionKeys.encryptionKey));
            contract.connect(owner).publishSenderEncryptionKey(sender, encryptionKeyHidden);
        });
    },

    setupSenderPrivacy: async (sender: HardhatEthersSigner, contract: PrivacyFirstContract) => {
        const waitForEncryptionKey = new Promise<{ sender: string; encryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            contract.connect(sender).on("SenderEncryptionKeyReady", (senderSc: string, encryptionKey: string, event: any) => {
                if(senderSc !== sender.address)
                    return;
                try {resolve({sender: senderSc, encryptionKey});} catch (err) {reject(err);}
            });
        });
        const senderKeys = cipher.generateKeyPair();
        let ownerPublicKey = await contract.connect(sender).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, senderKeys.publicKey);
        await contract.connect(sender).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));
        const encryptionKeyResult = await waitForEncryptionKey;
        const finalEncryptionKey = cipher.decryptStringHybrid(senderKeys.privateKey, JSON.parse(encryptionKeyResult.encryptionKey));
        expect (
            finalEncryptionKey
        ).to.not.equal("");
    }

}