import {
    loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import utils from "../testUtils/utils";
import {
    contractConfiguration,
    sender1,
    sender2,
    sender3,
    verifier1,
    verifier2,
    verifier3,
    verifier4,
    interestedUser,
    ownerKeys,
    owner
} from "../testUtils/constants";

const DST_OWNERS = [sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser];

require('dotenv').config();

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

let contractConfigurationSpatialChunking = {
    needs: contractConfiguration.needs,
    chunkConfig: contractConfiguration.chunkConfig,
    rewardConfig: {
        ...contractConfiguration.rewardConfig,
        dataSenderBond: 1,
        dataVerifierBond: 1
    },
    originCoordinates: contractConfiguration.originCoordinates,
}

async function contractDeployment() {
    const DST_OWNERS = [sender1];
    const DST_FOR_OWNERS = 100;

    const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
    const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenContract.deploy(999999999);
    const privacyContract = await PrivacyFirstContract.deploy(
        ownerKeys.publicKey,
        contractConfigurationSpatialChunking,
        await dataSentToken.getAddress()
    );

    await dataSentToken.connect(owner).approve(
        await privacyContract.getAddress(),
        contractConfigurationSpatialChunking.rewardConfig.totalDst
    );
    for (const dstOwner of DST_OWNERS) {
        await dataSentToken.transfer(await dstOwner.getAddress(), DST_FOR_OWNERS);
    }

    await privacyContract.connect(owner).payInitialSupply();
    return {privacyContract, dataSentToken}
}

describe("[SPATIAL CHUNKING] PrivacyFirstContract", function () {

    let env: Awaited<ReturnType<typeof contractDeployment>>;
    beforeEach(async function () {
        env = await loadFixture(contractDeployment);
        await env.privacyContract.removeAllListeners();
    });

    it("[SENDER]: Data with valid position is accepted", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");

        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, validPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent").withArgs(0);
    });

    it("[SENDER]: Data outside campaign area (north) is rejected", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, outsidePositionNorth)
        ).to.be.revertedWith("Outside campaign area");
    });

    it("[SENDER]: Data outside campaign area (west) is rejected", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, outsidePositionWest)
        ).to.be.revertedWith("Outside campaign area");
    });

    it("[SENDER]: Data at southwest corner is chunk 0", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);
        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, southwestPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent").withArgs(0);
    });

    it("[SENDER]: Data at northeast corner is accepted", async function () {
        const {privacyContract} = await loadFixture(contractDeployment);
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);
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
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);
        const cid = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid, invalidPosition)
        ).to.be.revertedWith("Invalid Coordinates");
    });

    const southwestPosition = {
        latitudeInteger: 41,
        latitudeDecimal: 1000000,
        longitudeInteger: 11,
        longitudeDecimal: 1000000,
    };

    async function chunkLimitDeployment() {
        const DST_FOR_OWNERS = 100;

        //@ts-ignore
        [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser] = await ethers.getSigners();
        const DST_OWNERS = [sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4];

        const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
        const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
        const dataSentToken = await DataSentTokenContract.deploy(999999999);
        const privacyContract = await PrivacyFirstContract.deploy(
            ownerKeys.publicKey,
            {
                needs: {
                    ...contractConfiguration.needs,
                    maximumDataPerChunk: 1,
                    maxDataPerSender: 0  // unlimited so chunk limit is tested, not sender limit
                },
                rewardConfig: contractConfiguration.rewardConfig,
                originCoordinates: contractConfiguration.originCoordinates,
                chunkConfig: contractConfiguration.chunkConfig
            },
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
        return {privacyContract, dataSentToken};
    }

    async function unlimitedChunkDeployment() {
        const DST_FOR_OWNERS = 100;
        //@ts-ignore
        [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser] = await ethers.getSigners();
        const DST_OWNERS = [sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4];

        const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
        const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
        const dataSentToken = await DataSentTokenContract.deploy(999999999);
        const privacyContract = await PrivacyFirstContract.deploy(
            ownerKeys.publicKey,
            {
                needs: {
                    ...contractConfiguration.needs,
                    maximumDataPerChunk: 0
                },
                rewardConfig: contractConfiguration.rewardConfig,
                originCoordinates: contractConfiguration.originCoordinates,
                chunkConfig: contractConfiguration.chunkConfig
            },
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
        return {privacyContract, dataSentToken};
    }

    it("[SENDER]: Data rejected when chunk is full", async function () {
        const {privacyContract} = await chunkLimitDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        const cid1 = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid1, validPosition);

        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid2, validPosition)
        ).to.be.revertedWith("Too many data in this chunk!");
    });

    it("[SENDER]: Different chunks accept data independently", async function () {
        const {privacyContract} = await chunkLimitDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        const cid1 = ethers.toUtf8Bytes("QmEncryptedCid_1");
        await privacyContract.connect(sender1).publishIpfsCid(cid1, validPosition);

        const cid2 = ethers.toUtf8Bytes("QmEncryptedCid_2");
        await expect(
            privacyContract.connect(sender1).publishIpfsCid(cid2, southwestPosition)
        ).to.emit(privacyContract, "DataVerificationRequestedEvent");
    });

    it("[SENDER]: maximumDataPerChunk = 0 means unlimited", async function () {
        const {privacyContract} = await unlimitedChunkDeployment();
        await utils.setupOwnerPrivacy(owner, privacyContract, ownerKeys);
        await utils.setupSenderPrivacy(sender1, privacyContract);
        await utils.dismantlingOwnerPrivacy(owner, privacyContract);

        for (let i = 0; i < 5; i++) {
            const cid = ethers.toUtf8Bytes(`QmEncryptedCid_${i}`);
            await privacyContract.connect(sender1).publishIpfsCid(cid, validPosition);
        }
    });

});