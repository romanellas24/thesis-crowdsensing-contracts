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

describe("[CAMPAIGN LIFECYCLE] PrivacyFirstContract", function () {

    let lifecycleConfig = {
        needs: {
            freshnessPeriod: 3600,
            dataNeeded: 1,
            checksRequired: 3,
            verifierCooldown: 1,
            verificationTimeout: 300,
            minimumParticipants: 1
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

    async function lifecycleDeployment() {
        [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser] = await ethers.getSigners();
        const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
        const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
        const dataSentToken = await DataSentTokenContract.deploy(999999999);
        const privacyContract = await PrivacyFirstContract.deploy(
            ownerKeys.publicKey,
            lifecycleConfig,
            await dataSentToken.getAddress()
        );
        await dataSentToken.connect(owner).approve(
            await privacyContract.getAddress(),
            lifecycleConfig.rewardConfig.totalDst
        );
        await privacyContract.connect(owner).payInitialSupply();
        return {privacyContract, dataSentToken};
    }

    async function readyForLifecycle() {
        const {privacyContract, dataSentToken} = await lifecycleDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);
        await utils.setupVerifierPrivacy(verifier3, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid);

        return {privacyContract, dataSentToken};
    }

    it("[CAMPAIGN]: Auto-closes when both thresholds met", async function () {
        const {privacyContract} = await loadFixture(readyForLifecycle);

        // checksRequired: 3, majority: 2
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0); // SUCCESS

        await privacyContract.connect(verifier2).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier2).submitVerifyResult(0) // SUCCESS -> majority
        ).to.emit(privacyContract, "DataVerified").withArgs(0, true)
            .and.to.emit(privacyContract, "CampaignClosed");
    });

    it("[CAMPAIGN]: Does not close when dataNeeded met but not minimumParticipants", async function () {
        // Deploy with higher minimumParticipants
        const higherParticipantsConfig = {
            ...lifecycleConfig,
            needs: { ...lifecycleConfig.needs, minimumParticipants: 5 }
        };
        [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser] = await ethers.getSigners();
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
        await privacyContract.connect(owner).payInitialSupply();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await expect(
            privacyContract.connect(verifier2).submitVerifyResult(0)
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
            privacyContract.connect(sender1).publishIpfsCid(cid)
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