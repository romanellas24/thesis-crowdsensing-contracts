import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import utils from "../testUtils/utils";
import {contractDeployment, sender1, verifier1, verifier2, verifier3, verifier4, owner, ownerKeys, validPosition, interestedUser} from "../testUtils/constants";
require('dotenv').config();

describe("[DATA SUBMISSION] PrivacyFirstContract", function () {

    it("[SENDER]: Sends encrypted CID to SC", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        const cid1 = ethers.toUtf8Bytes("QmEncryptedCid_1");
        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        const cid3 = ethers.toUtf8Bytes("QmEncryptedCid_3");

        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid1, validPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent")
            .withArgs(0);

        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid2, validPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent")
            .withArgs(1);

        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid3, validPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent")
            .withArgs(2);
    });

    async function readyForVerification() {
        const {privacyContract} = await contractDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);
        await utils.setupVerifierPrivacy(verifier3, privacyContract);
        await utils.setupVerifierPrivacy(verifier4, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);

        return {privacyContract};
    }

    it("[VERIFIER]: Enrolled verifier requests and gets assigned", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.emit(privacyContract, "VerifierElected");
    });

    it("[VERIFIER]: Non-enrolled user cannot request verification", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await expect(
            privacyContract.connect(interestedUser).requestAuthToVerify()
        ).to.be.revertedWith("Only verifiers allowed");
    });

    it("[VERIFIER]: Cannot request while already verifying", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.be.revertedWith("Already verifying data");
    });

    it("[VERIFIER]: Submit SUCCESS", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier1).submitVerifyResult(0) // SUCCESS
        ).to.not.be.reverted;
    });

    it("[VERIFIER]: Submit REJECTED", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier1).submitVerifyResult(1) // REJECTED
        ).to.not.be.reverted;
    });

    it("[VERIFIER]: Submit CANNOT_COMPLETE and retry", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(2); // CANNOT_COMPLETE

        // Verifier can request again
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.emit(privacyContract, "VerifierElected");
    });

    it("[VERIFIER]: Cannot submit without active verification", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        await expect(
            privacyContract.connect(verifier1).submitVerifyResult(0)
        ).to.be.revertedWith("No active verification");
    });

    it("[VERIFIER]: Majority SUCCESS, then data VALID", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);

        // checksRequired: 3, majority: 2
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0);

        // verifier1 has cooldown=1, so submit more data first for cooldown
        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        await privacyContract.connect(sender1).publishIpfsCid(cid2, validPosition);

        await privacyContract.connect(verifier4).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier4).submitVerifyResult(0)
        ).to.emit(privacyContract, "DataVerified").withArgs(0, true);
    });

    it("[VERIFIER]: Majority REJECTED, then data INVALID", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(1);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(1);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(1);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier4).submitVerifyResult(1)
        ).to.emit(privacyContract, "DataVerified").withArgs(0, false);
    });

    it("[VERIFIER]: Mixed results, no majority yet", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0); // SUCCESS

        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        await privacyContract.connect(sender1).publishIpfsCid(cid2, validPosition);

        await privacyContract.connect(verifier2).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier2).submitVerifyResult(1)
        ).to.not.emit(privacyContract, "DataVerified");
    });

    it("[VERIFIER]: Cooldown prevents immediate re-verification", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0);

        // verifier1 just verified dataId 0, cooldown=1
        // No other pending data exists -> should revert
        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.be.revertedWith("No data available for verification");
    });

    it("[VERIFIER]: Expired deadline prevents submission", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        const {time} = await import("@nomicfoundation/hardhat-toolbox/network-helpers");

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(1);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(1);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(1);
        await privacyContract.connect(verifier4).requestAuthToVerify();

        await time.increase(301);

        await expect(
            privacyContract.connect(verifier4).submitVerifyResult(1)
        ).to.not.emit(privacyContract, "DataVerified");
    });

    it("[VERIFIER]: Expired slot can be reassigned", async function () {
        const {privacyContract} = await loadFixture(readyForVerification);
        const {time} = await import("@nomicfoundation/hardhat-toolbox/network-helpers");

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await time.increase(301);

        // verifier1 tries to submit -> expired, needs to free themselves
        await privacyContract.connect(verifier1).submitVerifyResult(2); // CANNOT_COMPLETE

        // verifier2 picks up the same data
        await expect(
            privacyContract.connect(verifier2).requestAuthToVerify()
        ).to.emit(privacyContract, "VerifierElected");
    });

});

