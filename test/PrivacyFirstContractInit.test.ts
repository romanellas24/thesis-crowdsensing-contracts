import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import cipher from "../testUtils/cipher";
import utils from "../testUtils/utils";

require('dotenv').config();

const MAX_DST = 1000000;

let owner: HardhatEthersSigner, interestedUser: HardhatEthersSigner,
    sender1: HardhatEthersSigner, sender2: HardhatEthersSigner, sender3: HardhatEthersSigner,
    verifier1: HardhatEthersSigner, verifier2: HardhatEthersSigner, verifier3: HardhatEthersSigner, verifier4: HardhatEthersSigner;
const ownerKeys = cipher.generateKeyPair();

let contractConfiguration = {
    needs: {
        freshnessPeriod: 3600,
        dataNeeded: 3,
        checksRequired: 7,
        verifierCooldown: 2,
        verificationTimeout: 300
    },
    chunkConfig: {
        chunkSize: 1000000,
        chunk4Side: 5
    },
    rewardConfig: {
        totalDst: MAX_DST,
        dataSenderBond: 1,
        dataVerifierBond: 1,
        dataSenderPayout: 100,
        dataVerifierPayout: 30
    },
    originCoordinates: {
        latitudeInteger: 41,
        latitudeDecimal: 1000000,
        longitudeInteger: 11,
        longitudeDecimal: 1000000,
    }
}

async function contractDeployment() {
    [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser] = await ethers.getSigners();
    const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
    const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenContract.deploy(999999999);
    const privacyContract = await PrivacyFirstContract.deploy(
        ownerKeys.publicKey,
        contractConfiguration,
        await dataSentToken.getAddress()
    );
    return {privacyContract}
}

describe("[INIT PHASE - SENDER] PrivacyFirstContract", function () {

    it("[OWNER]: Deployment", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);

        expect(await (
            privacyContract.getDeployedCode()
        )).to.not.null;
    });

    it("[OWNER]: Encryption keys generation", async function () {
        let encryptionKeys = cipher.generateEncryptionKeys();
        let string = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer sed.";
        let secretString = cipher.encryptStringHybrid(encryptionKeys.encryptionKey, string);
        expect(secretString).not.to.equal(string);
        let stringAgain = cipher.decryptStringHybrid(encryptionKeys.decryptionKey, secretString).toString();
        expect(stringAgain).to.equal(string);
    });

    it("[AGENT]: A lot of text to crypt/decrypt", async function () {
        const agentKeys = cipher.generateKeyPair();
        const largeText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Praesent non orci ligula. Cras consequat urna eu mattis mattis. Proin dolor enim, varius tristique odio vel, ullamcorper cursus enim. Pellentesque sagittis ultrices tempor. Praesent sollicitudin diam at nisi euismod, eu lacinia massa pellentesque. Quisque et dapibus nibh. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae; Maecenas varius lectus et commodo luctus. Duis congue turpis dignissim, sagittis arcu vitae, tincidunt ante. Vivamus varius dignissim lectus, quis consequat augue suscipit interdum. Etiam porttitor enim nulla, interdum cursus leo semper ac. Nulla convallis scelerisque ipsum, ullamcorper gravida purus ultrices vel. Curabitur vehicula ornare quam, quis porttitor diam malesuada quis. Duis id lacus tortor. Nam ut finibus turpis. Cras mollis porta volutpat. Nam enim eros, condimentum sed commodo eget, aliquet eu est. Nam at turpis velit. Nulla placerat, sem id ornare pharetra, urna nulla bibendum dolor, eu facilisis ipsum nibh in velit. Sed et leo vitae dui blandit viverra. Maecenas eget purus elit. Ut porta nibh eros, quis vehicula elit porttitor ut. Aenean non quam eu est blandit porta. Aliquam venenatis ut dolor sit amet commodo. Nullam sed nibh auctor est venenatis vehicula. Donec euismod quam tempus, volutpat sem vel, ullamcorper massa. Aliquam erat volutpat. Vivamus elementum metus a varius maximus. Sed bibendum purus in condimentum feugiat. Duis nibh massa, congue eu risus et, euismod cursus velit. Nullam sed sem id libero scelerisque aliquet in in sapien. Curabitur quam lorem, euismod sit amet fringilla non, malesuada in massa. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Class aptent taciti sociosqu ad litora torquent per conubia nostra, per inceptos himenaeos. Praesent sodales suscipit est, in accumsan diam tristique vitae. Nunc pulvinar interdum orci, non convallis neque pretium in. Vestibulum eu pretium dolor. Donec lacinia libero in quam varius condimentum. Ut accumsan, odio sit amet luctus maximus, libero dolor scelerisque lorem, eu lobortis leo lacus quis mi. Maecenas at nibh eget nisi tincidunt commodo a ac est. Curabitur quam arcu, sagittis non justo a, euismod ultrices sapien. Suspendisse ac elit eu mauris egestas aliquam. Cras facilisis arcu non neque ullamcorper, eu tincidunt est tristique. Ut nisi nunc, aliquet non enim ut, porttitor pretium neque. Nullam sodales urna enim, id consectetur urna mattis ac. Nulla aliquam finibus massa quis eleifend. Nunc interdum nunc ac aliquet molestie. Interdum et malesuada fames ac ante ipsum primis in faucibus. Morbi sed turpis venenatis, viverra odio ut, feugiat tellus. In viverra felis ac malesuada maximus. Mauris rhoncus risus ac erat molestie varius sit amet eget elit. Sed metus nunc, vulputate a euismod ac, lobortis quis velit. Nullam vehicula rutrum risus vel porttitor. Duis quis tortor faucibus, mollis metus et, ornare ex. Morbi blandit, velit non laoreet fringilla, lorem nisi hendrerit sapien, ac feugiat tellus tellus tincidunt ex. Nulla vitae fermentum tortor. Nullam et risus velit. Sed porttitor libero eget dolor pulvinar, et feugiat erat pellentesque.";
        let encrypted = cipher.encryptStringHybrid(agentKeys.publicKey, largeText);
        let decrypted = cipher.decryptStringHybrid(agentKeys.privateKey, encrypted);
        expect(decrypted).to.equal(largeText);
    });

    it("[SENDER]: Retrieve owner's public key", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        expect(ownerPublicKey).to.equal(ownerKeys.publicKey);
    });

    it("[SENDER]: Sender sends their public key encrypted using owner's publicKey", async function () {
        const senderKeys = cipher.generateKeyPair();
        const {privacyContract} = await loadFixture(contractDeployment);
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, senderKeys.publicKey);
        let transaction = await privacyContract.connect(sender1).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));
        expect(transaction.blockHash).not.null;
    });

    it("[OWNER]: Owner listen for SenderEnrolledEvent and decrypt key", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        const waitForEvent = new Promise<{ sender: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.once("SenderEnrolledEvent", (sender: string, key: string, event: any) => {
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

    it("[OWNER]: Owner send encryption key only for sender", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        const waitForEvent = new Promise<{ sender: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("SenderEnrolledEvent", (sender: string, key: string, event: any) => {
                try {
                    resolve({sender, key});
                } catch (err) {
                    reject(err);
                }
            });
        });
        let encryptionKeys = cipher.generateEncryptionKeys();
        const senderKeys = cipher.generateKeyPair();
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, senderKeys.publicKey);
        await privacyContract.connect(sender1).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));

        // Wait until the event is actually seen
        const result = await waitForEvent;
        const bundle = JSON.parse(result.key);
        const senderPublicKey = cipher.decryptStringHybrid(ownerKeys.privateKey, bundle)
        expect(senderPublicKey).to.equal(senderKeys.publicKey);
        const encryptionKeyHidden = JSON.stringify(cipher.encryptStringHybrid(senderPublicKey, encryptionKeys.encryptionKey));
        privacyContract.connect(owner).publishSenderEncryptionKey(result.sender, encryptionKeyHidden);
        const waitForEncryptionKey = new Promise<{ sender: string; encryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(sender1).once("SenderEncryptionKeyReady", (sender: string, encryptionKey: string, event: any) => {
                try {
                    resolve({sender, encryptionKey});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const encryptionKeyResult = await waitForEncryptionKey;
        expect(encryptionKeyResult.sender).to.equal(result.sender).to.equal(sender1.address);
    });

    it("[SENDER]: Decrypt encryptionKey sent by owner in confidential way", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        const waitForEvent = new Promise<{ sender: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("SenderEnrolledEvent", (sender: string, key: string, event: any) => {
                try {
                    resolve({sender, key});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const waitForEncryptionKey = new Promise<{ sender: string; encryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(sender1).once("SenderEncryptionKeyReady", (sender: string, encryptionKey: string, event: any) => {
                try {
                    resolve({sender, encryptionKey});
                } catch (err) {
                    reject(err);
                }
            });
        });
        let encryptionKeys = cipher.generateEncryptionKeys();
        const senderKeys = cipher.generateKeyPair();
        let ownerPublicKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, senderKeys.publicKey);
        await privacyContract.connect(sender1).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));

        // Wait until the event is actually seen
        const result = await waitForEvent;
        const bundle = JSON.parse(result.key);
        const senderPublicKey = cipher.decryptStringHybrid(ownerKeys.privateKey, bundle)
        expect(senderPublicKey).to.equal(senderKeys.publicKey);
        const encryptionKeyHidden = JSON.stringify(cipher.encryptStringHybrid(senderPublicKey, encryptionKeys.encryptionKey));
        await privacyContract.connect(owner).publishSenderEncryptionKey(result.sender, encryptionKeyHidden);
        const encryptionKeyResult = await waitForEncryptionKey;
        const finalEncryptionKey = cipher.decryptStringHybrid(senderKeys.privateKey, JSON.parse(encryptionKeyResult.encryptionKey));
        expect(finalEncryptionKey).to.equal(encryptionKeys.encryptionKey);
    });

    it('[OWNER/SENDER] Use created functions to join SC', async () => {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        let promises = [];
        promises.push(utils.setupSenderPrivacy(sender1, privacyContract));
        promises.push(utils.setupSenderPrivacy(sender2, privacyContract));
        promises.push(utils.setupSenderPrivacy(sender3, privacyContract));
        await Promise.all(promises);
    });

    it("[SENDER]: Sender1 duplicate the enrollment request", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        expect(
            utils.setupSenderPrivacy(sender1, privacyContract)
        ).to.be.revertedWith("Sender has already requested to join'")
    });

});

describe("[INIT PHASE - VERIFIER] PrivacyFirstContract", function () {

    it('[VERIFIER] generates their key pair', async () => {
        let verifierKeys = cipher.generateKeyPair();
        let string = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer sed.";
        let secretString = cipher.encryptStringHybrid(verifierKeys.publicKey, string);
        expect(secretString).not.to.equal(string);
        let stringAgain = cipher.decryptStringHybrid(verifierKeys.privateKey, secretString).toString();
        expect(stringAgain).to.equal(string);
    });

    it("[VERIFIER] Retrieve owner's public key", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        let ownerPublicKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        expect(ownerPublicKey).to.equal(ownerKeys.publicKey);
    });

    it("[VERIFIER]: Verifier sends their public key encrypted using owner's publicKey", async function () {
        const verifierKeys = cipher.generateKeyPair();
        const {privacyContract} = await loadFixture(contractDeployment);
        let ownerPublicKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPublicKey, verifierKeys.publicKey);
        let transaction = await privacyContract.connect(verifier1).publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPubKey));
        expect(transaction.blockHash).not.null;
    });

    it("[OWNER]: Wait for VerifierEnrolledEvent", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        const waitForVerifier = new Promise<{ verifier: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("VerifierEnrolledEvent", (verifier: string, key: string, event: any) => {
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
        const {privacyContract} = await loadFixture(contractDeployment);
        const waitForVerifier = new Promise<{ verifier: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("VerifierEnrolledEvent", (verifier: string, key: string, event: any) => {
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


    it("[VERIFIER]: Decrypt encryptionKey sent by owner in confidential way", async function () {
        const {privacyContract} = await contractDeployment();
        const waitForVerifier = new Promise<{ verifier: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(owner).once("VerifierEnrolledEvent", (verifier: string, key: string, event: any) => {
                try {
                    resolve({verifier, key});
                } catch (err) {
                    reject(err);
                }
            });
        });
        const waitForEncryptionKey = new Promise<{ verifier: string; key: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(verifier1).once("VerifierDecryptionKeyReady", (verifier: string, key: string, event: any) => {
                if (verifier !== verifier1.address)
                    return;
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
        const decryptionKey = cipher.encryptStringHybrid(vKey, encryptionKeys.decryptionKey);
        await privacyContract.connect(owner).publishVerifierDecryptionKey(verifierInfo.verifier, JSON.stringify(decryptionKey))
        let encryptedKey = (await waitForEncryptionKey).key;
        encryptedKey = cipher.decryptStringHybrid(verifierKeys.privateKey, JSON.parse(encryptedKey));
        expect(encryptedKey).to.equal(encryptionKeys.decryptionKey);
    });

});

