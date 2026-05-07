import {ethers} from "hardhat";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {PrivacyFirstContract} from "../typechain-types";
import cipher from "./cipher";
import {expect} from "chai";
import {sender1} from "./constants";

export default {
    getPublicKey: async (user: HardhatEthersSigner) => {
        // messaggio fisso
        const messageHash = ethers.id("dummy"); // keccak256("dummy")
        const messageHashBytes = ethers.getBytes(messageHash);

        // firma del messaggio
        const signature = await user.signMessage(messageHashBytes);

        // ricavo della chiave pubblica
        return ethers.SigningKey.recoverPublicKey(messageHashBytes, signature);
    },

    // TODO CHIUDERE QUESTI LISTENER
    setupOwnerPrivacy: async (owner: HardhatEthersSigner, contract: PrivacyFirstContract, ownerKeys: { publicKey: string, privateKey: string }) => {
        const encryptionKeys = cipher.generateEncryptionKeys();
        // @ts-ignore
        contract.connect(owner).on("SenderEnrolledEvent", async (sender: string, key: string, event: any) => {
            const bundle = JSON.parse(key);
            const senderPublicKey = cipher.decryptStringHybrid(ownerKeys.privateKey, bundle)
            const encryptionKeyHidden = JSON.stringify(cipher.encryptStringHybrid(senderPublicKey, encryptionKeys.encryptionKey));
            await contract.connect(owner).publishSenderEncryptionKey(sender, encryptionKeyHidden);
        });
        // @ts-ignore
        contract.connect(owner).on("VerifierEnrolledEvent", async (verifier: string, key: string, event: any) => {
            const bundle = JSON.parse(key);
            const verifierPublicKey = cipher.decryptStringHybrid(ownerKeys.privateKey, bundle);
            const decryptionKeyHidden = JSON.stringify(cipher.encryptStringHybrid(verifierPublicKey, encryptionKeys.decryptionKey));
            await contract.connect(owner).publishVerifierDecryptionKey(verifier, decryptionKeyHidden);
        });
    },

    dismantlingOwnerPrivacy: async (owner: HardhatEthersSigner, contract: PrivacyFirstContract) => {
        // @ts-ignore
        await contract.connect(owner).off("SenderEnrolledEvent");
        // @ts-ignore
        await contract.connect(owner).on("VerifierEnrolledEvent");
    },

    setupSenderPrivacy: async (sender: HardhatEthersSigner, contract: PrivacyFirstContract) => {
        const waitForEncryptionKey = new Promise<{ sender: string; encryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            contract.connect(sender).on("SenderEncryptionKeyReady", (senderSc: string, encryptionKey: string, event: any) => {
                if(senderSc !== sender.address)
                    return;
                try {
                    contract.connect(sender).off("SenderEncryptionKeyReady");
                    resolve({sender: senderSc, encryptionKey});
                } catch (err) {reject(err);}
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

        const dstAddress = await contract.getDstScAddress();
        const dataSentToken = await ethers.getContractAt("DataSentTokenContract", dstAddress);
        await dataSentToken.connect(sender).approve(
            await contract.getAddress(),
            await contract.getRequiredSenderBond()
        );
        await contract.connect(sender).senderPayBond();
    },

    setupVerifierPrivacy: async (verifier: HardhatEthersSigner, contract: PrivacyFirstContract) => {
        const waitForDecryptionKey = new Promise<{ verifier: string; decryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            contract.connect(verifier).on("VerifierDecryptionKeyReady", (verifierSc: string, decryptionKey: string, event: any) => {
                if (verifierSc !== verifier.address)
                    return;
                try {
                    contract.connect(verifier).off("VerifierDecryptionKeyReady");
                    resolve({verifier: verifierSc, decryptionKey});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const verifierKeys = cipher.generateKeyPair();
        let ownerPublicKey = await contract.connect(verifier).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, verifierKeys.publicKey);
        await contract.connect(verifier).publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPubKey));
        const decryptionKeyResult = await waitForDecryptionKey;
        const finalDecryptionKey = cipher.decryptStringHybrid(verifierKeys.privateKey, JSON.parse(decryptionKeyResult.decryptionKey));
        expect(
            finalDecryptionKey
        ).to.not.equal("");

        const dstAddress = await contract.getDstScAddress();
        const dataSentToken = await ethers.getContractAt("DataSentTokenContract", dstAddress);
        await dataSentToken.connect(verifier).approve(
            await contract.getAddress(),
            await contract.getRequiredVerifierBond()
        );
        await contract.connect(verifier).verifierPayBond();
    }
}