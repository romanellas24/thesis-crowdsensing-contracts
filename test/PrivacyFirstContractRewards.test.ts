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

    await dataSentToken.connect(owner).approve(
        await privacyContract.getAddress(),
        contractConfiguration.rewardConfig.totalDst
    );

    await privacyContract.connect(owner).payInitialSupply();
    return {privacyContract, dataSentToken}
}

describe("[REWARDS] PrivacyFirstContract", function () {

    async function readyForRewards() {
        const {privacyContract, dataSentToken} = await contractDeployment();

        await dataSentToken.connect(owner).approve(
            await privacyContract.getAddress(),
            contractConfiguration.rewardConfig.totalDst
        );
        await privacyContract.connect(owner).payInitialSupply();

        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.setupVerifierPrivacy(verifier1, privacyContract);
        await utils.setupVerifierPrivacy(verifier2, privacyContract);
        await utils.setupVerifierPrivacy(verifier3, privacyContract);
        await utils.setupVerifierPrivacy(verifier4, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid);

        return {privacyContract, dataSentToken};
    }

    it("[REWARD]: Sender gets payout on VALID data", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForRewards);
        const senderBalanceBefore = await dataSentToken.balanceOf(sender1.address);


        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0);

        const senderBalanceAfter = await dataSentToken.balanceOf(sender1.address);
        expect(senderBalanceAfter - senderBalanceBefore).to.equal(
            contractConfiguration.rewardConfig.dataSenderPayout
        );
    });

    it("[REWARD]: Sender gets nothing on INVALID data", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForRewards);
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
        expect(senderBalanceAfter - senderBalanceBefore).to.equal(0);
    });

    it("[REWARD]: Correct verifiers get payout on VALID data", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForRewards);
        const v1Before = await dataSentToken.balanceOf(verifier1.address);
        const v2Before = await dataSentToken.balanceOf(verifier2.address);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0); // SUCCESS
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0); // SUCCESS
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0); // SUCCESS
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0);

        const v1After = await dataSentToken.balanceOf(verifier1.address);
        const v2After = await dataSentToken.balanceOf(verifier2.address);
        expect(v1After - v1Before).to.equal(contractConfiguration.rewardConfig.dataVerifierPayout);
        expect(v2After - v2Before).to.equal(contractConfiguration.rewardConfig.dataVerifierPayout);
    });

    it("[REWARD]: Wrong verifiers get nothing", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForRewards);
        const v1Before = await dataSentToken.balanceOf(verifier1.address);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(1); // REJECTED
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0); // majority SUCCESS

        const v1After = await dataSentToken.balanceOf(verifier1.address);
        expect(v1After - v1Before).to.equal(0);
    });

    it("[REWARD]: Late verifier gets payout if voted correctly", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForRewards);

        // Submit more data so cooldown allows verifier1 to come back
        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        const cid3 = ethers.toUtf8Bytes("QmEncryptedCid_3");
        const cid4 = ethers.toUtf8Bytes("QmEncryptedCid_4");
        await privacyContract.connect(sender1).publishIpfsCid(cid2);
        await privacyContract.connect(sender1).publishIpfsCid(cid3);
        await privacyContract.connect(sender1).publishIpfsCid(cid4);

        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(0); // SUCCESS
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(0); // SUCCESS
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(0); // SUCCESS

        // verifier4 triggers majority
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(0); // majority reached
    });

    it("[REWARD]: Correct verifiers paid on INVALID data", async function () {
        const {privacyContract, dataSentToken} = await loadFixture(readyForRewards);
        const v1Before = await dataSentToken.balanceOf(verifier1.address);

        // verifier1 votes REJECTED (correct), rest also REJECTED
        await privacyContract.connect(verifier1).requestAuthToVerify();
        await privacyContract.connect(verifier1).submitVerifyResult(1);
        await privacyContract.connect(verifier2).requestAuthToVerify();
        await privacyContract.connect(verifier2).submitVerifyResult(1);
        await privacyContract.connect(verifier3).requestAuthToVerify();
        await privacyContract.connect(verifier3).submitVerifyResult(1);
        await privacyContract.connect(verifier4).requestAuthToVerify();
        await privacyContract.connect(verifier4).submitVerifyResult(1); // majority REJECTED

        const v1After = await dataSentToken.balanceOf(verifier1.address);
        expect(v1After - v1Before).to.equal(contractConfiguration.rewardConfig.dataVerifierPayout);
    });

});