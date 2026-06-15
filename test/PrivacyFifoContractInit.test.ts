import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import cipher from "../testUtils/cipher";
import utils from "../testUtils/utils";

require('dotenv').config();

import {contractDeploymentFifo, sender1, sender2, verifier1, owner, ownerKeys} from "../testUtils/constants";

describe("[INIT PHASE - SENDER] PrivacyFifoContract", function () {

    let env: Awaited<ReturnType<typeof contractDeploymentFifo>>;
    beforeEach(async function () {
        env = await loadFixture(contractDeploymentFifo);
        await env.privacyContract.removeAllListeners();
    });

    it("[OWNER]: Deployment", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);

        expect(await (
            privacyContract.getDeployedCode()
        )).to.not.null;
    });

    it("[SENDER]: Retrieve owner's public key", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        expect(ownerPublicKey).to.equal(ownerKeys.publicKey);
    });

    it("[SENDER]: Sender sends their public key encrypted using owner's publicKey", async function () {
        const senderKeys = cipher.generateKeyPair();
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, senderKeys.publicKey);
        let transaction = await privacyContract.connect(sender1).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));
        expect(transaction.blockHash).not.null;
    });

    it("[OWNER]: Owner listen for SenderEnrolledEvent and decrypt key", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        const waitForEvent = new Promise<{ sender: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.once("SenderEnrolledEvent", (sender: string, key: string) => {
                try {
                    resolve({sender, key});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const senderKeys = cipher.generateKeyPair();
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, senderKeys.publicKey);
        await privacyContract.connect(sender1).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));

        // Wait until the event is actually seen
        const result = await waitForEvent;
        const bundle = JSON.parse(result.key);
        const senderPublicKey = cipher.decryptStringHybrid(ownerKeys.privateKey, bundle)
        expect(senderPublicKey).to.equal(senderKeys.publicKey);
    });

    it("[SENDER]: Sender1 duplicate the enrollment request", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender2, privacyContract);
        expect(
            utils.setupSenderPrivacy(sender2, privacyContract)
        ).to.be.revertedWith("Sender has already joined")
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);
    });

});

describe("[INIT PHASE - VERIFIER] PrivacyFifoContract", function () {

    it("[VERIFIER] Retrieve owner's public key", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        let ownerPublicKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        expect(ownerPublicKey).to.equal(ownerKeys.publicKey);
    });

    it("[VERIFIER]: Verifier sends their public key encrypted using owner's publicKey", async function () {
        const verifierKeys = cipher.generateKeyPair();
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        let ownerPublicKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, verifierKeys.publicKey);
        let transaction = await privacyContract.connect(verifier1).publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPubKey));
        expect(transaction.blockHash).not.null;
    });

    it("[OWNER]: Wait for VerifierEnrolledEvent", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        const waitForVerifier = new Promise<{ verifier: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("VerifierEnrolledEvent", (verifier: string, key: string) => {
                try {
                    resolve({verifier, key});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const verifierKeys = cipher.generateKeyPair();
        let ownerPublicKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, verifierKeys.publicKey);
        await privacyContract.connect(verifier1).publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPubKey));
        const verifierInfo = await waitForVerifier;
        expect(
            verifierInfo.verifier
        ).to.equal(verifier1.address);
        expect(
            JSON.parse(verifierInfo.key)
        ).not.throws
    });

    it("[OWNER]: Calculate verifier public key", async function () {
        const {privacyContract} = await loadFixture(contractDeploymentFifo);
        const waitForVerifier = new Promise<{ verifier: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("VerifierEnrolledEvent", (verifier: string, key: string) => {
                try {
                    resolve({verifier, key});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const verifierKeys = cipher.generateKeyPair();
        const encryptionKeys = cipher.generateEncryptionKeys();
        let ownerPublicKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, verifierKeys.publicKey);
        await privacyContract.connect(verifier1).publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPubKey));
        const verifierInfo = await waitForVerifier;
        expect(
            verifierInfo.verifier
        ).to.equal(verifier1.address);
        const vKeyObject = JSON.parse(verifierInfo.key);
        const vKey = cipher.decryptStringHybrid(ownerKeys.privateKey, vKeyObject);
        const encryptionKey = cipher.encryptStringHybrid(vKey, encryptionKeys.encryptionKey);
        await privacyContract.connect(owner).publishVerifierDecryptionKey(verifierInfo.verifier, JSON.stringify(encryptionKey))
    });

});

