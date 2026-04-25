import {expect} from "chai";
import {ethers} from "hardhat";
import {contractConfiguration, ownerKeys, validPosition} from "../testUtils/constants";
import cipher from "../testUtils/cipher";


// helpers
const SCALE = 10n ** 18n;

function sqrtBigInt(x: bigint): bigint {
    if (x === 0n) return 0n;
    let z = (x + 1n) / 2n;
    let y = x;
    while (z < y) { y = z; z = (x / z + z) / 2n; }
    return y;
}

function computeDecayedReward(
    payout: bigint,
    countBeforeSubmission: bigint,
    maxPerChunk: bigint,
    k: bigint
): bigint {
    if (maxPerChunk === 0n) return payout;
    let ratio = (maxPerChunk - countBeforeSubmission) * SCALE / maxPerChunk;
    for (let i = 0n; i < k; i++) ratio = sqrtBigInt(ratio * SCALE);
    return payout * ratio / SCALE;
}


// Constants
const PAYOUT = 100n;
const BOND_PER_DATA = 1n;
const MAX_PER_CHUNK = 4n;
const encryptedCid = ethers.toUtf8Bytes("encrypted_cid");


// Helpers
async function submitAndVerify(
    sc: any,
    dataSentToken: any,
    owner: any,
    sender: any,
    verifier: any,
    verifierKeys: any,
    dataId: number
): Promise<number> {
    const before = await dataSentToken.balanceOf(sender.address);

    await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
    await sc.connect(owner).notifyVerificationKeyReady(dataId);
    await sc.connect(verifier).requestAuthToVerify();

    const bundlePayload = JSON.stringify({cidV: "QmXyz", kdDec: "kd"});
    const bundle = ethers.toUtf8Bytes(
        JSON.stringify(cipher.encryptStringHybrid(verifierKeys.publicKey, bundlePayload))
    );
    await sc.connect(owner).deliverVerificationBundle(dataId, verifier.address, bundle);
    await sc.connect(verifier).submitVerifyResult(0);

    const after = await dataSentToken.balanceOf(sender.address);
    return after - before;
}

async function deploySecondContract(maximumDataPerChunk: number, k: number, decayEnabled: boolean = true) {
    const [owner, sender, verifier] = await ethers.getSigners();

    const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenContract.deploy(999999999);

    const PrivacySecondContract = await ethers.getContractFactory("PrivacySecondContract");
    const config = {
        ...contractConfiguration,
        needs: {
            ...contractConfiguration.needs,
            checksRequired: 1,
            verifierCooldown: 1,
            maximumDataPerChunk: maximumDataPerChunk,
            maxDataPerSender: 10,
            maxDataPerVerifierPerBond: 10,
        },
        rewardConfig: {
            ...contractConfiguration.rewardConfig,
            dataSenderPayout: Number(PAYOUT),
            dataSenderBondPerData: Number(BOND_PER_DATA),
        }
    };
    const novelParams = {
        rewardDecayEnabled: decayEnabled,
        rewardDecayFactor: k,
        kickVerifierAfterWrongVotes: 0,
        pardonWrongVoteAfterRightVotes: 0,
    };


    const sc = await PrivacySecondContract.deploy(
        ownerKeys.publicKey,
        config,
        await dataSentToken.getAddress(),
        novelParams
    );

    await dataSentToken.transfer(sender.address, 5000);
    await dataSentToken.transfer(verifier.address, 500);
    await dataSentToken.connect(owner).approve(
        await sc.getAddress(),
        contractConfiguration.rewardConfig.totalDst
    );
    await sc.connect(owner).payInitialSupply();

    const senderKeys = cipher.generateKeyPair();
    await sc.connect(sender).publishEncryptedSenderPublicKey(
        JSON.stringify(cipher.encryptStringHybrid(ownerKeys.publicKey, senderKeys.publicKey))
    );
    await sc.connect(owner).publishSenderEncryptionKey(
        sender.address,
        JSON.stringify(cipher.encryptStringHybrid(senderKeys.publicKey, "kenc"))
    );
    await dataSentToken.connect(sender).approve(await sc.getAddress(), 5000);
    await sc.connect(sender).senderPayBond();

    const verifierKeys = cipher.generateKeyPair();
    await sc.connect(verifier).publishEncryptedVerifierPublicKey(
        JSON.stringify(cipher.encryptStringHybrid(ownerKeys.publicKey, verifierKeys.publicKey))
    );
    await sc.connect(owner).publishVerifierDecryptionKey(verifier.address, "");
    await dataSentToken.connect(verifier).approve(await sc.getAddress(), 500);
    await sc.connect(verifier).verifierPayBond();

    return {sc, dataSentToken, owner, sender, verifier, verifierKeys};
}


// Tests
describe("PrivacySecondContract - reward decay", () => {

    it("[PSC] full payout when rewardDecayEnabled = false", async () => {
        const ctx = await deploySecondContract(Number(MAX_PER_CHUNK), 1, false);
        const delta = await submitAndVerify(ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 0);
        expect(delta).to.equal(PAYOUT + BOND_PER_DATA);
    });

    it("[PSC] full payout when maximumDataPerChunk = 0 ", async () => {
        const ctx = await deploySecondContract(0, 1);
        const delta = await submitAndVerify(
            ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 0
        );
        expect(delta).to.equal(PAYOUT + BOND_PER_DATA);
    });

    it("[PSC] first submission (count=0) receives full payout regardless of k", async () => {
        for (const k of [0, 1, 2, 3]) {
            const ctx = await deploySecondContract(Number(MAX_PER_CHUNK), k);
            const delta = await submitAndVerify(
                ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 0
            );
            expect(delta).to.equal(PAYOUT + BOND_PER_DATA, `failed at k=${k}`);
        }
    });

    it("[PSC] k=0 applies linear decay r = payout * (1 - alpha)", async () => {
        const k = 0n;
        const ctx = await deploySecondContract(Number(MAX_PER_CHUNK), Number(k));

        await submitAndVerify(ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 0);

        const delta = await submitAndVerify(
            ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 1
        );
        const expected = computeDecayedReward(PAYOUT, 1n, MAX_PER_CHUNK, k) + BOND_PER_DATA;
        expect(delta).to.equal(expected);
    });

    it("[PSC] k=1 applies sqrt decay r = payout * sqrt(1 - alpha)", async () => {
        const k = 1n;
        const ctx = await deploySecondContract(Number(MAX_PER_CHUNK), Number(k));

        await submitAndVerify(ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 0);

        const delta = await submitAndVerify(
            ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 1
        );
        const expected = computeDecayedReward(PAYOUT, 1n, MAX_PER_CHUNK, k) + BOND_PER_DATA;
        expect(delta).to.equal(expected);
    });

    it("[PSC] k=2 applies double-sqrt decay r = payout * (1-alpha)^(1/4)", async () => {
        const k = 2n;
        const ctx = await deploySecondContract(Number(MAX_PER_CHUNK), Number(k));

        await submitAndVerify(ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 0);
        await submitAndVerify(ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 1);

        const delta = await submitAndVerify(
            ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, 2
        );
        const expected = computeDecayedReward(PAYOUT, 2n, MAX_PER_CHUNK, k) + BOND_PER_DATA;
        expect(delta).to.equal(expected);
    });

    it("[PSC] reward decays monotonically as chunk fills up", async () => {
        const ctx = await deploySecondContract(Number(MAX_PER_CHUNK), 1);
        const payouts: bigint[] = [];

        for (let i = 0; i < Number(MAX_PER_CHUNK) - 1; i++) {
            const delta = await submitAndVerify(
                ctx.sc, ctx.dataSentToken, ctx.owner, ctx.sender, ctx.verifier, ctx.verifierKeys, i
            );
            // @ts-ignore
            payouts.push(delta - BOND_PER_DATA);
        }

        for (let i = 1; i < payouts.length; i++) {
            expect(payouts[i]).to.be.lte(payouts[i - 1], `reward increased at step ${i}`);
        }
    });

    it("[PSC] higher k means gentler decay at same alpha (off-chain formula check)", async () => {
        const countBefore = 2n; // alpha = 2/4 = 0.5

        const r0 = computeDecayedReward(PAYOUT, countBefore, MAX_PER_CHUNK, 0n);
        const r1 = computeDecayedReward(PAYOUT, countBefore, MAX_PER_CHUNK, 1n);
        const r2 = computeDecayedReward(PAYOUT, countBefore, MAX_PER_CHUNK, 2n);

        expect(r2).to.be.gte(r1);
        expect(r1).to.be.gte(r0);
    });
});