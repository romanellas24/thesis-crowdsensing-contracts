import {ethers} from "hardhat";
import type {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import cipher from "../testUtils/cipher";

export const MAX_DST = 1000000;

export let owner: HardhatEthersSigner, interestedUser: HardhatEthersSigner,
    sender1: HardhatEthersSigner, sender2: HardhatEthersSigner, sender3: HardhatEthersSigner,
    verifier1: HardhatEthersSigner, verifier2: HardhatEthersSigner, verifier3: HardhatEthersSigner,
    verifier4: HardhatEthersSigner;
export const ownerKeys = cipher.generateKeyPair();

export const contractConfiguration = {
    needs: {
        freshnessPeriod: 3600,
        dataNeeded: 3,
        checksRequired: 7,
        verifierCooldown: 2,
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

export const validPosition = {
    latitudeInteger: 41,
    latitudeDecimal: 3500000,
    longitudeInteger: 11,
    longitudeDecimal: 3500000,
};

export async function contractDeployment() {
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

export async function lifecycleDeployment() {
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
    return {privacyContract, dataSentToken};
}

export async function oneDataRequiredDeployment() {
    [owner, sender1, sender2, sender3, verifier1, verifier2, verifier3, verifier4, interestedUser] = await ethers.getSigners();
    const PrivacyFirstContract = await ethers.getContractFactory("PrivacyFirstContract");
    const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenContract.deploy(999999999);
    const privacyContract = await PrivacyFirstContract.deploy(
        ownerKeys.publicKey,
        {
            needs: {
                ...contractConfiguration.needs,
                dataNeeded: 1,
                checksRequired: 1
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
    await privacyContract.connect(owner).payInitialSupply();
    return {privacyContract, dataSentToken};
}