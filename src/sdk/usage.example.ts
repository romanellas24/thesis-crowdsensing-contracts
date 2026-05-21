import {ethers, network} from "hardhat";
import {MAX_DST, ownerKeys} from "../../testUtils/constants";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {OwnerPrivacySecond} from "./PSC/OwnerPrivacySecond";
import cipher from "../../testUtils/cipher";
import {VerifierPrivacySecond} from "./PSC/VerifierPrivacySecond";
import {PrivacySecondContract} from "../../typechain-types";
import {DataSentTokenContract} from "../../typechain-types/contracts/contracts";
import {VerificationResult} from "./utils/CipherProvider";

const contractConfiguration = {
    needs: {
        dataNeeded: 5,
        checksRequired: 7,
        verifierCooldown: 2,
        verificationTimeout: 300,
        minimumParticipants: 1,
        maxDataPerSender: 5,
        maxDataPerVerifierPerBond: 5,
        maximumDataPerChunk: 10
    },
    chunkConfig: {
        chunkSize: 1000000,
        chunk4Side: 5
    },
    rewardConfig: {
        totalDst: MAX_DST,
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

const defaultNovelParams = {
    rewardDecayEnabled: false,
    rewardDecayFactor: 1,
    pardonWrongVoteAfterRightVotes: 3,
    kickVerifierAfterWrongVotes: 10,
};

async function makeSigner(): Promise<HardhatEthersSigner> {
    const wallet = ethers.Wallet.createRandom();

    await network.provider.send("hardhat_impersonateAccount", [wallet.address]);
    await network.provider.send("hardhat_setBalance", [
        wallet.address,
        "0x56BC75E2D63100000", // 100 ETH
    ]);

    return await ethers.getSigner(wallet.address); // HardhatEthersSigner
}

async function getSigners(signersNo: number): Promise<HardhatEthersSigner[]> {
    const promiseAll: Promise<HardhatEthersSigner>[] = [];
    for (let i = 0; i < signersNo; i++) {
        promiseAll.push(makeSigner());
    }
    return Promise.all(promiseAll);
}

async function getOneSigner(){
    return (await getSigners(1))[0];
}

async function makeVerifiers(verifierNo: number, contract: PrivacySecondContract, dstContract: DataSentTokenContract): Promise<VerifierPrivacySecond[]> {
    const signers: HardhatEthersSigner[] = await getSigners(verifierNo);
    const verifiers = [];
    for (const signer of signers)
        verifiers.push(new VerifierPrivacySecond(signer, contract, dstContract, cipher, () => {return VerificationResult.SUCCESS}));

    return verifiers;
}

async function main() {
    const DataSentTokenFactory = await ethers.getContractFactory("DataSentTokenContract");
    const PSCFactory = await ethers.getContractFactory("PrivacySecondContract");

    const _owner = await getOneSigner();
    const dataSentToken = await DataSentTokenFactory.connect(_owner).deploy(999_999_999);
    const dataSentTokenAddress = await dataSentToken.getAddress();

    const privacyContract = await PSCFactory.connect(_owner).deploy(
        ownerKeys.publicKey,
        contractConfiguration,
        dataSentTokenAddress,
        defaultNovelParams,
    );

    const owner  = new OwnerPrivacySecond(_owner, privacyContract, dataSentToken, ownerKeys, cipher)
    await owner.setup();

    const VERIFIER_DST = 1000n;
    const SENDER_DST = 100n;

    const verifiers = await makeVerifiers(5, privacyContract, dataSentToken);
    const handles = [];
    for (const verifier of verifiers) {
        handles.push(await verifier.fullSetup());
    }


    for(const v of verifiers)
        await dataSentToken.connect(_owner).transfer(v.getAddress(), VERIFIER_DST);

    //TODO METTERE I SENDERS

    //Experiments start here

    //Esperiments end here
    handles.forEach(h => h.stop());
    await Promise.all(handles.map(h => h.done));
    console.log("All loops terminated.");
}

main();