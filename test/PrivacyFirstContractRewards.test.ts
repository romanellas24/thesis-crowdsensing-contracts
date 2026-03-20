import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import utils from "../testUtils/utils";

require('dotenv').config();

import {contractDeployment, sender1, verifier1, verifier2, verifier3, verifier4, owner, ownerKeys, validPosition, contractConfiguration} from "../testUtils/constants";
import {bigint} from "hardhat/internal/core/params/argumentTypes";

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
        await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);

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
        expect(senderBalanceAfter - BigInt(contractConfiguration.rewardConfig.dataSenderBondPerData)  - senderBalanceBefore).to.equal(
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
        expect(v1After - v1Before - BigInt(contractConfiguration.rewardConfig.dataSenderBondPerData)).to.equal(contractConfiguration.rewardConfig.dataVerifierPayout);
        expect(v2After - v2Before - BigInt(contractConfiguration.rewardConfig.dataSenderBondPerData)).to.equal(contractConfiguration.rewardConfig.dataVerifierPayout);
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
        const {privacyContract} = await loadFixture(readyForRewards);

        // Submit more data so cooldown allows verifier1 to come back
        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        const cid3 = ethers.toUtf8Bytes("QmEncryptedCid_3");
        const cid4 = ethers.toUtf8Bytes("QmEncryptedCid_4");
        await privacyContract.connect(sender1).publishIpfsCid(cid2, validPosition);
        await privacyContract.connect(sender1).publishIpfsCid(cid3, validPosition);
        await privacyContract.connect(sender1).publishIpfsCid(cid4, validPosition);

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
        expect(v1After - v1Before + BigInt(contractConfiguration.rewardConfig.dataSenderBondPerData)).to.equal(contractConfiguration.rewardConfig.dataVerifierPayout);
    });

});