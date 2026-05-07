import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import utils from "../testUtils/utils";

require('dotenv').config();

import {
    lifecycleDeployment,
    sender1,
    sender2,
    sender3,
    verifier1,
    verifier2,
    verifier3,
    verifier4,
    owner,
    ownerKeys,
    validPosition,
    contractConfiguration,
    oneDataRequiredDeployment
} from "../testUtils/constants";

describe("[CAMPAIGN LIFECYCLE] PrivacyFirstContract", function () {



    async function readyForLifecycle() {
        const {privacyContract, dataSentToken} = await lifecycleDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);
        await utils.setupVerifierPrivacy(verifier3, privacyContract);
        await utils.setupVerifierPrivacy(verifier4, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);
        return {privacyContract, dataSentToken};
    }

    it("[CAMPAIGN]: Auto-closes when both thresholds met", async function () {
        const {privacyContract} = await loadFixture(oneDataRequiredDeployment);

        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);

        await utils.setupVerifierPrivacy(verifier4, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        await privacyContract.connect(verifier4).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier4).submitVerifyResult(0)
        ).to.emit(privacyContract, "DataVerified").withArgs(0, true)
            .and.to.emit(privacyContract, "CampaignClosed");
    });

    it("[CAMPAIGN]: Does not close when dataNeeded met but not minimumParticipants", async function () {
        // Deploy with higher minimumParticipants
        const higherParticipantsConfig = {
            ...contractConfiguration,
            needs: { ...contractConfiguration.needs, minimumParticipants: 5 }
        };
        // @ts-ignore
        [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4] = await ethers.getSigners();
        const DST_OWNERS = [sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4];
        const DST_FOR_OWNERS = 100;

        const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
        const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
        const dataSentToken = await DataSentTokenContract.deploy(999999999);
        const privacyContract = await PrivacyFirstContract.deploy(
            ownerKeys.publicKey,
            higherParticipantsConfig,
            await dataSentToken.getAddress()
        );
        await dataSentToken.connect(owner).approve(
            await privacyContract.getAddress(),
            higherParticipantsConfig.rewardConfig.totalDst
        );
        for (const dstOwner of DST_OWNERS) {
            await dataSentToken.transfer(await dstOwner.getAddress(), DST_FOR_OWNERS);
        }
        await privacyContract.connect(owner).payInitialSupply();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);
        await utils.setupVerifierPrivacy(verifier3, privacyContract);
        await utils.setupVerifierPrivacy(verifier4, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier4).requestAuthToVerify();

        await privacyContract.connect(verifier1).submitVerifyResult(0);
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).submitVerifyResult(0);
        await expect(
            privacyContract.connect(verifier4).submitVerifyResult(0)
        ).to.emit(privacyContract, "DataVerified").withArgs(0, true)
            .and.to.not.emit(privacyContract, "CampaignClosed");
    });

    it("[CAMPAIGN]: Owner can manually close", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);
        await expect(
            privacyContract.connect(owner).closeCampaign()
        ).to.emit(privacyContract, "CampaignClosed");
    });

    it("[CAMPAIGN]: Non-owner cannot close", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);
        await expect(
            privacyContract.connect(sender1).closeCampaign()
        ).to.be.revertedWith("Only owner");
    });

    it("[CAMPAIGN]: Cannot close twice", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);
        await privacyContract.connect(owner).closeCampaign();
        await expect(
            privacyContract.connect(owner).closeCampaign()
        ).to.be.revertedWith("Campaign already closed");
    });

    it("[CAMPAIGN]: Sender cannot submit data after close", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);
        await privacyContract.connect(owner).closeCampaign();

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_2");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, validPosition)
        ).to.be.revertedWith("Campaign is closed");
    });

    it("[CAMPAIGN]: Verifier cannot request new verification after close", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);
        await privacyContract.connect(owner).closeCampaign();

        await expect(
            privacyContract.connect(verifier1).requestAuthToVerify()
        ).to.be.revertedWith("Campaign is closed");
    });

    it("[CAMPAIGN]: New sender cannot enroll after close", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);
        await privacyContract.connect(owner).closeCampaign();

        const fakeKey = JSON.stringify({iv: "a", tag: "b", encKey: "c", ct: "d"});
        await expect(
            privacyContract.connect(sender2).publishEncryptedSenderPublicKey(fakeKey)
        ).to.be.revertedWith("Campaign is closed");
    });

    it("[CAMPAIGN]: Assigned verifier can still submit after close", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(owner).closeCampaign();

        await expect(
            privacyContract.connect(verifier1).submitVerifyResult(0) // SUCCESS
        ).to.not.be.reverted;
    });

});