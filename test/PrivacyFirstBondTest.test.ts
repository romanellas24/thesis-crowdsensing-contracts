import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import utils from "../testUtils/utils";
import {
    contractDeployment, validPosition,
    owner, ownerKeys,
    sender1, interestedUser,
    verifier1, verifier2, verifier3, verifier4
} from "../testUtils/constants";

require('dotenv').config();

describe("[BOND MECHANISM] PrivacyFirstContract", function () {

    async function enrolledSenderNoBond() {
        const {privacyContract, dataSentToken} = await contractDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);

        // Enroll sender manually WITHOUT paying bond
        const waitForEncryptionKey = new Promise<{ sender: string; encryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(sender1).once("SenderEncryptionKeyReady", (senderSc: string, encryptionKey: string) => {
                if (senderSc !== sender1.address) return;
                try { resolve({sender: senderSc, encryptionKey}); } catch (err) { reject(err); }
            });
        });
        const cipher = (await import("../testUtils/cipher")).default;
        const senderKeys = cipher.generateKeyPair();
        const ownerPubKey = await privacyContract.connect(sender1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPubKey, senderKeys.publicKey);
        await privacyContract.connect(sender1).publishEncryptedSenderPublicKey(JSON.stringify(encryptedPubKey));
        await waitForEncryptionKey;
        // sender1 is enrolled but has NOT paid bond

        return {privacyContract, dataSentToken};
    }

    async function enrolledVerifierNoBond() {
        const {privacyContract, dataSentToken} = await contractDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        // Enroll verifier manually WITHOUT paying bond
        const waitForDecryptionKey = new Promise<{ verifier: string; decryptionKey: string }>((resolve, reject) => {
            // @ts-ignore
            privacyContract.connect(verifier1).once("VerifierDecryptionKeyReady", (verifierSc: string, decryptionKey: string) => {
                if (verifierSc !== verifier1.address) return;
                try { resolve({verifier: verifierSc, decryptionKey}); } catch (err) { reject(err); }
            });
        });
        const cipher = (await import("../testUtils/cipher")).default;
        const verifierKeys = cipher.generateKeyPair();
        const ownerPubKey = await privacyContract.connect(verifier1).getInitiatorPublicKey();
        const encryptedPubKey = cipher.encryptStringHybrid(ownerPubKey, verifierKeys.publicKey);
        await privacyContract.connect(verifier1).publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPubKey));
        await waitForDecryptionKey;

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);

        return {privacyContract, dataSentToken};
    }

    async function readyForBondTests() {
        const {privacyContract, dataSentToken} = await contractDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);
        await utils.setupVerifierPrivacy(verifier3, privacyContract);
        await utils.setupVerifierPrivacy(verifier4, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);

        return {privacyContract, dataSentToken};
    }

    it("[BOND]: Sender without bond cannot submit data", async function () {
        const {privacyContract} = await loadFixture(enrolledSenderNoBond);
        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, validPosition)
        ).to.be.revertedWith("Insufficient DST balance in bond, please refund");
    });

    it("[BOND]: Sender bond restored after VALID verification", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForBondTests);

        // 4 SUCCESS votes -> majority (checksRequired: 7, majority: 4)
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0);

        // Sender should have received bond back + payout
        const senderBalance = await dataSentToken.balanceOf(sender1.address);
        // senderBalance should include the payout
        expect(senderBalance).to.be.greaterThan(0);
    });

    it("[BOND]: Sender bond NOT restored after INVALID verification", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForBondTests);
        const senderBalanceBefore = await dataSentToken.balanceOf(sender1.address);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(1);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(1);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(1);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(1);

        const senderBalanceAfter = await dataSentToken.balanceOf(sender1.address);
        expect(senderBalanceAfter).to.equal(senderBalanceBefore);
    });

    it("[BOND]: maxDataPerSender rejects after limit", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);

        // maxDataPerSender: 5, already submitted 1 in fixture
        for (let i = 2; i <= 5; i++) {
            const cid = ethers.toUtf8Bytes(`QmEncryptedCid_${i}`);
            await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);
        }

        const cid6 = ethers.toUtf8Bytes("QmEncryptedCid_6");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid6, validPosition)
        ).to.be.revertedWith("Max data limit reached");
    });

    it("[BOND]: Non-sender cannot pay sender bond", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);
        await expect(
            privacyContract.connect(interestedUser).senderPayBond()
        ).to.be.revertedWith("Not a sender");
    });

    // =====================
    // VERIFIER BOND TESTS
    // =====================

    it("[BOND]: Verifier without bond cannot request verification", async function () {
        const {privacyContract} = await loadFixture(enrolledVerifierNoBond);
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.be.revertedWith("Insufficient DST balance in bond, please refund");
    });

    it("[BOND]: Verifier bond restored on correct vote", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForBondTests);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0);

        // verifier1 voted correctly -> bond restored + payout received
        const v1Balance = await dataSentToken.balanceOf(verifier1.address);
        expect(v1Balance).to.be.greaterThan(0);
    });

    it("[BOND]: Verifier bond NOT restored on wrong vote", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForBondTests);
        const v1BalanceBefore = await dataSentToken.balanceOf(verifier1.address);

        // verifier1 votes REJECTED, rest vote SUCCESS -> data VALID, verifier1 wrong
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(1); // REJECTED
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0);

        const v1BalanceAfter = await dataSentToken.balanceOf(verifier1.address);
        // No payout, no bond refund -> balance unchanged
        expect(v1BalanceAfter).to.equal(v1BalanceBefore);
    });

    it("[BOND]: Verifier bond restored on CANNOT_COMPLETE", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        // Bond was deducted on requestAuthToVerify
        await privacyContract.connect(verifier1).submitVerifyResult(2); // CANNOT_COMPLETE
        // Bond should be restored

        // Verifier can request again (proves bond is sufficient)
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.emit(privacyContract, "VerifierElected");
    });

    it("[BOND]: Verifier bond restored on expired deadline", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);
        const {time} = await import("@nomicfoundation/hardhat-toolbox/network-helpers");

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await time.increase(301);

        // Expired -> submit triggers free + refund
        await privacyContract.connect(verifier1).submitVerifyResult(0);

        // Verifier can request again (proves bond was restored)
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.emit(privacyContract, "VerifierElected");
    });

    it("[BOND]: Non-verifier cannot pay verifier bond", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);
        await expect(
            privacyContract.connect(interestedUser).verifierPayBond()
        ).to.be.revertedWith("Not a verifier");
    });

    // =====================
    // WITHDRAW TESTS
    // =====================

    it("[WITHDRAW]: Sender can withdraw bond after campaign close", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForBondTests);
        const balanceBefore = await dataSentToken.balanceOf(sender1.address);

        await privacyContract.connect(owner).closeCampaign();
        await privacyContract.connect(sender1).withdrawBond();

        const balanceAfter = await dataSentToken.balanceOf(sender1.address);
        expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("[WITHDRAW]: Verifier can withdraw bond after campaign close", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForBondTests);
        const balanceBefore = await dataSentToken.balanceOf(verifier1.address);

        await privacyContract.connect(owner).closeCampaign();
        await privacyContract.connect(verifier1).withdrawBond();

        const balanceAfter = await dataSentToken.balanceOf(verifier1.address);
        expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("[WITHDRAW]: Non-participant cannot withdraw", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);
        await expect(
            privacyContract.connect(interestedUser).withdrawBond()
        ).to.be.revertedWith("Not a sender neither verifier");
    });

    it("[WITHDRAW]: Cannot withdraw with zero balance", async function () {
        const {privacyContract} = await loadFixture(readyForBondTests);
        await privacyContract.connect(owner).closeCampaign();
        await privacyContract.connect(sender1).withdrawBond();

        // Second withdraw should fail
        await expect(
            privacyContract.connect(sender1).withdrawBond()
        ).to.be.revertedWith("Nothing to withdraw");
    });

});