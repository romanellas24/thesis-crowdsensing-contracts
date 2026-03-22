import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import cipher from "../testUtils/cipher";
import utils from "../testUtils/utils";

require('dotenv').config();

let owner: HardhatEthersSigner, sender1: HardhatEthersSigner;
const ownerKeys = cipher.generateKeyPair();

// Valid position: center of the area
const validPosition = {
    latitudeInteger: 41,
    latitudeDecimal: 3500000,
    longitudeInteger: 11,
    longitudeDecimal: 3500000,
};

const MAX_DST = 1000000;

// Position outside campaign area (too far north)
const outsidePositionNorth = {
    latitudeInteger: 42,
    latitudeDecimal: 0,
    longitudeInteger: 11,
    longitudeDecimal: 3500000,
};

// Position outside campaign area (too far west)
const outsidePositionWest = {
    latitudeInteger: 41,
    latitudeDecimal: 3500000,
    longitudeInteger: 10,
    longitudeDecimal: 0,
};

// Position at origin (southwest corner): chunk (0,0) = index 0
const southwestPosition = {
    latitudeInteger: 41,
    latitudeDecimal: 1000000,
    longitudeInteger: 11,
    longitudeDecimal: 1000000,
};

// Position at northeast area: chunk (4,4) = index 24
const northeastPosition = {
    latitudeInteger: 41,
    latitudeDecimal: 5900000,  // 41.59° (just inside the last chunk)
    longitudeInteger: 11,
    longitudeDecimal: 5900000,  // 11.59°
};

let contractConfiguration = {
    needs: {
        freshnessPeriod: 3600,
        dataNeeded: 3,
        checksRequired: 7,
        verifierCooldown: 2,
        verificationTimeout: 300,
        minimumParticipants: 1,
        maxDataPerSender: 5,
        maxDataPerVerifierPerBond: 5
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
        dataVerifierPayout: 30,
        dataSenderBondPerData: 1,
        dataVerifierBondPerData: 1
    },
    originCoordinates: {
        latitudeInteger: 41,
        latitudeDecimal: 1000000,
        longitudeInteger: 11,
        longitudeDecimal: 1000000,
    }
}

async function contractDeployment() {
    [owner, sender1] = await ethers.getSigners();
    const DST_OWNERS = [sender1];
    const DST_FOR_OWNERS = 100;

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
    for (const dstOwner of DST_OWNERS) {
        await dataSentToken.transfer(await dstOwner.getAddress(), DST_FOR_OWNERS);
    }

    await privacyContract.connect(owner).payInitialSupply();
    return {privacyContract, dataSentToken}
}

describe("[SPATIAL CHUNKING] PrivacyFirstContract", function () {

    it("[SENDER]: Data with valid position is accepted", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, validPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent").withArgs(0);
    });

    it("[SENDER]: Data outside campaign area (north) is rejected", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, outsidePositionNorth)
        ).to.be.revertedWith("Outside campaign area");
    });

    it("[SENDER]: Data outside campaign area (west) is rejected", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, outsidePositionWest)
        ).to.be.revertedWith("Outside campaign area");
    });

    it("[SENDER]: Data at southwest corner is chunk 0", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, southwestPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent").withArgs(0);
    });

    it("[SENDER]: Data at northeast corner is accepted", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, northeastPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent").withArgs(0);
    });

    it("[SENDER]: Invalid coordinates rejected", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);

        const invalidPosition = {
            latitudeInteger: 91,  // invalid: max is 90
            latitudeDecimal: 0,
            longitudeInteger: 11,
            longitudeDecimal: 0,
        };

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, invalidPosition)
        ).to.be.revertedWith("Invalid Coordinates");
    });

});