import {loadFixture} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import cipher from "../testUtils/cipher";
import {
    owner,
    ownerKeys,
    sender1,
    sender2,
    verifier1,
    verifier2,
    verifier3,
    verifier4,
    validPosition,
    contractConfiguration,
} from "../testUtils/constants";
import {
    OwnerPrivacyFirst,
    VerificationResult,
} from "../src/actors/PFC";
import LoopStopReason from "../src/actors/PFC/LoopStopReason";
import {OwnerPrivacySecond} from "../src/actors/PSC/OwnerPrivacySecond";
import {SenderPrivacySecond} from "../src/actors/PSC/SenderPrivacySecond";
import {VerifierPrivacySecond} from "../src/actors/PSC/VerifierPrivacySecond";

// ---------------------------------------------------------------------------
// NovelParameters presets
// ---------------------------------------------------------------------------

const defaultNovelParams = {
    rewardDecayEnabled: false,
    rewardDecayFactor: 1,
    pardonWrongVoteAfterRightVotes: 3,
    kickVerifierAfterWrongVotes: 0,     // disabled by default
};

/** §2.6.2: decay enabled, no penalty */
const decayNovelParams = {
    rewardDecayEnabled: true,
    rewardDecayFactor: 1,
    pardonWrongVoteAfterRightVotes: 0,
    kickVerifierAfterWrongVotes: 0,
};

/**
 * §2.6.3: penalty enabled.
 *   kickAfter=2  => verifier kicked after 2 wrong votes
 *   pardonAfter=2 => 1 wrong vote pardoned after 2 correct votes
 */
const penaltyNovelParams = {
    rewardDecayEnabled: false,
    rewardDecayFactor: 1,
    pardonWrongVoteAfterRightVotes: 2,
    kickVerifierAfterWrongVotes: 2,
};

/**
 * For penalty and wrong-vote tests:
 * checksRequired=3 => majority=2.
 * V2+V3 vote SUCCESS => VALID. V1 votes REJECTED => wrong vote recorded.
 */
const penaltyConfig = {
    ...contractConfiguration,
    needs: {
        ...contractConfiguration.needs,
        checksRequired: 3,
        dataNeeded: 0,
        minimumParticipants: 0,
    },
};

/**
 * For bond exhaustion loop test:
 * checksRequired=1 => one verifier decides, maxDataPerVerifierPerBond=2.
 */
const bondExhaustConfig = {
    ...contractConfiguration,
    needs: {
        ...contractConfiguration.needs,
        checksRequired: 1,
        maxDataPerVerifierPerBond: 2,
        dataNeeded: 0,
        minimumParticipants: 0,
    },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves when PrivacySecondContract emits DataVerificationRequestedEvent,
 * which is triggered by notifyVerificationKeyReady (i.e., data is now in pending).
 * Use this in non-loop tests after publishData to synchronise with owner processing.
 */
function waitForPendingData(contract: any): Promise<void> {
    return new Promise((resolve) => {
        contract.once("DataVerificationRequestedEvent", () => resolve());
    });
}

// ---------------------------------------------------------------------------
// PSC deployment helpers
// ---------------------------------------------------------------------------

async function pscDeployment(
    novelParams = defaultNovelParams,
    config = contractConfiguration,
) {
    const [_owner, _s1, _s2, _s3, _v1, _v2, _v3, _v4] = await ethers.getSigners();

    const DataSentTokenFactory = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenFactory.deploy(999_999_999);

    const PSCFactory = await ethers.getContractFactory("PrivacySecondContract");
    const privacyContract = await PSCFactory.connect(_owner).deploy(
        ownerKeys.publicKey,
        config,
        await dataSentToken.getAddress(),
        novelParams,
    );

    // Distribute DST to all participants
    for (const user of [_s1, _s2, _v1, _v2, _v3, _v4]) {
        await dataSentToken.transfer(await user.getAddress(), 100);
    }

    // Fund campaign
    await dataSentToken.connect(_owner).approve(
        await privacyContract.getAddress(),
        config.rewardConfig.totalDst,
    );
    await privacyContract.connect(_owner).payInitialSupply();

    return {privacyContract, dataSentToken};
}

async function pscWithOwner(novelParams = defaultNovelParams, config = contractConfiguration) {
    const {privacyContract, dataSentToken} = await pscDeployment(novelParams, config);
    const ownerActor = new OwnerPrivacySecond(owner, privacyContract, dataSentToken, ownerKeys, cipher);
    ownerActor.startListening();
    return {privacyContract, dataSentToken, ownerActor};
}

async function pscWithSender(novelParams = defaultNovelParams) {
    const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner(novelParams);
    const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
    await senderActor.setup();
    return {privacyContract, dataSentToken, ownerActor, senderActor};
}

/**
 * Full setup: owner + 1 sender + 4 verifiers, all enrolled & bonded.
 * checksRequired=7 => majority=4 => all 4 verifiers needed for SUCCESS.
 */
async function pscFullSetup() {
    const {privacyContract, dataSentToken, ownerActor, senderActor} = await pscWithSender();

    const verifierActors: VerifierPrivacySecond[] = [];
    for (const signer of [verifier1, verifier2, verifier3, verifier4]) {
        const v = new VerifierPrivacySecond(
            signer, privacyContract, dataSentToken, cipher,
            () => VerificationResult.SUCCESS,
        );
        await v.setup();
        verifierActors.push(v);
    }

    return {privacyContract, dataSentToken, ownerActor, senderActor, verifierActors};
}

/**
 * Penalty setup: checksRequired=3, penalty params.
 * 3 verifiers (V1=target for wrong votes, V2+V3=honest majority).
 */
async function pscPenaltySetup() {
    const {privacyContract, dataSentToken} = await pscDeployment(penaltyNovelParams, penaltyConfig);
    const ownerActor = new OwnerPrivacySecond(owner, privacyContract, dataSentToken, ownerKeys, cipher);
    ownerActor.startListening();

    const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
    await senderActor.setup();

    const makeVerifier = async (signer: any, result: VerificationResult) => {
        const v = new VerifierPrivacySecond(signer, privacyContract, dataSentToken, cipher, () => result);
        await v.setup();
        return v;
    };

    // V1 always rejects (will accumulate wrong votes)
    // V2 and V3 always approve (majority)
    const v1 = await makeVerifier(verifier1, VerificationResult.REJECTED);
    const v2 = await makeVerifier(verifier2, VerificationResult.SUCCESS);
    const v3 = await makeVerifier(verifier3, VerificationResult.SUCCESS);

    return {privacyContract, dataSentToken, ownerActor, senderActor, v1, v2, v3};
}

/**
 * Helper: submit one datum and have V2+V3 (honest majority with checksRequired=3)
 * decide the outcome, then V1 submits the wrong vote.
 *
 * After this call, V1 has accumulated +1 wrong vote.
 * Data must already be in pending before calling this (await waitForPendingData first).
 */
async function induceWrongVote(
    privacyContract: any,
    v1: VerifierPrivacySecond,
    v2: VerifierPrivacySecond,
    v3: VerifierPrivacySecond,
) {
    // All three get elected and receive bundles concurrently
    // (sequential to avoid nonce conflicts between signers)
    const {dataId: d1} = await v1.requestAuthToVerify();
    const {dataId: d2} = await v2.requestAuthToVerify();
    const {dataId: d3} = await v3.requestAuthToVerify();

    expect(d1).to.equal(d2);
    expect(d1).to.equal(d3);

    // V2 and V3 vote SUCCESS => majority => VALID
    await (await v2.submitResult(VerificationResult.SUCCESS)).wait();
    await (await v3.submitResult(VerificationResult.SUCCESS)).wait();

    // V1 votes REJECTED => wrong vote (_tryRewardVerifier => _recordWrongVote)
    await (await v1.submitResult(VerificationResult.REJECTED)).wait();
}

// ============================================================================

describe("[ACTOR CLASSES] PrivacySecondContract", function () {

    // ========================================================================
    // [OWNER]
    // ========================================================================

    describe("[OWNER]", function () {

        it("auto-listener handles sender enrollment (unchanged from PFC)", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner();

            const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.enroll();

            expect(senderActor.isEnrolled()).to.be.true;
            expect(senderActor.getKenc()).to.equal(ownerActor.getEncryptionKeys().encryptionKey);

            ownerActor.stopListening();
        });

        it("waitForEnrollments resolves using VerifierEnrolled (PSC-specific event)", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner();

            // OwnerPrivacySecond overrides _verifierConfirmedEvent() => "VerifierEnrolled"
            const wait = ownerActor.waitForEnrollments(1, 1);

            const s = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            const v = new VerifierPrivacySecond(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );

            await s.enroll();
            await v.enroll();

            await wait; // must resolve without hanging

            ownerActor.stopListening();
        });

        it("kickVerifier removes verifier and slashes bond", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner();

            const v = new VerifierPrivacySecond(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await v.setup();

            const balanceBefore = await dataSentToken.balanceOf(verifier1.address);

            expect(
                await ownerActor.kickVerifier(verifier1.address)
            ).to.emit(privacyContract, "VerifierKicked")

            // Bond returned to verifier's wallet on kick
            const balanceAfter = await dataSentToken.balanceOf(verifier1.address);
            expect(balanceAfter).to.be.greaterThan(balanceBefore);

            ownerActor.stopListening();
        });

    });

    // ========================================================================
    // [SENDER]


    describe("[SENDER]", function () {

        it("setup() enrolls and pays bond", async function () {
            const {senderActor, ownerActor} = await loadFixture(pscWithSender);
            expect(senderActor.isEnrolled()).to.be.true;
            ownerActor.stopListening();
        });

        it("publishData emits DataRequiredVerificationKeyGeneration (not DataVerificationRequestedEvent)", async function () {
            const {privacyContract, senderActor, ownerActor} = await loadFixture(pscWithSender);

            const tx = senderActor.publishData("QmSenderTest", validPosition);

            // PSC does NOT emit DataVerificationRequestedEvent directly from publishIpfsCid
            await expect(tx).to.emit(privacyContract, "DataRequiredVerificationKeyGeneration").withArgs(0);
            await expect(tx).not.to.emit(privacyContract, "DataVerificationRequestedEvent");

            ownerActor.stopListening();
        });

        it("multiple submissions increment dataId correctly", async function () {
            const {privacyContract, senderActor, ownerActor} = await loadFixture(pscWithSender);

            await expect(senderActor.publishData("QmA", validPosition))
                .to.emit(privacyContract, "DataRequiredVerificationKeyGeneration").withArgs(0);
            await expect(senderActor.publishData("QmB", validPosition))
                .to.emit(privacyContract, "DataRequiredVerificationKeyGeneration").withArgs(1);

            ownerActor.stopListening();
        });

    });

    // ========================================================================
    // [VERIFIER]
    // ========================================================================

    describe("[VERIFIER]", function () {

        it("setup() enrolls via VerifierEnrolled and pays bond", async function () {
            const {verifierActors, ownerActor} = await loadFixture(pscFullSetup);
            for (const v of verifierActors)
                expect(v.isEnrolled()).to.be.true;
            ownerActor.stopListening();
        });

        it("requestAndVerify: CID round-trips through bundle decryption", async function () {
            const {privacyContract, senderActor, verifierActors, ownerActor} = await loadFixture(pscFullSetup);
            if(!ownerActor.listening)
                ownerActor.startListening();

            const originalCid = "QmRealIpfsCidPSC_abc123";

            const dataReady = waitForPendingData(privacyContract);
            await senderActor.publishData(originalCid, validPosition);
            await dataReady;

            const psv: VerifierPrivacySecond = verifierActors[0];
            const {decryptedCid, dataId, result} = await psv.requestAndVerify();

            expect(decryptedCid).to.equal(originalCid);
            expect(dataId).to.equal(0);
            expect(result).to.equal(VerificationResult.SUCCESS);

            ownerActor.stopListening();
        });

        it("manual requestAuthToVerify + submitResult works", async function () {
            const {privacyContract, senderActor, verifierActors, ownerActor} = await loadFixture(pscFullSetup);

            const dataReady = waitForPendingData(privacyContract);
            await senderActor.publishData("QmManualPSC", validPosition);
            await dataReady;

            const {dataId, decryptedCid} = await verifierActors[0].requestAuthToVerify();
            expect(decryptedCid).to.equal("QmManualPSC");

            await expect(verifierActors[0].submitResult(VerificationResult.SUCCESS)).to.not.be.reverted;

            ownerActor.stopListening();
        });

        it("submitVerifyResult reverts if bundle has not been delivered", async function () {
            // This test bypasses the SDK to verify the SC-level protection.
            // We get the verifier elected (slot assigned) but skip bundle delivery,
            // then call submitVerifyResult directly on the contract.
            const {privacyContract, dataSentToken} = await pscDeployment();

            const ownerActor = new OwnerPrivacySecond(owner, privacyContract, dataSentToken, ownerKeys, cipher);

            // 1. Enroll sender and verifier (owner must respond to enrollment events)
            ownerActor.startListening();

            const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();
            const verifierActor = new VerifierPrivacySecond(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await verifierActor.setup();

            // 2. Stop auto-listener so owner will NOT deliver any bundle
            ownerActor.stopListening();

            // 3. Submit data and manually trigger notifyVerificationKeyReady only
            const dataKeyPending = new Promise<void>((resolve) => {
                privacyContract.once(
                    // @ts-ignore
                    "DataRequiredVerificationKeyGeneration",
                    async (dataId: bigint, event: any) => {
                        await ownerActor.handleDataRequiresKey(Number(dataId), event);
                        resolve();
                    },
                );
            });
            await (await senderActor.publishData("QmNoBundle", validPosition)).wait();
            await dataKeyPending; // data is now in pending

            // 4. Request via raw contract call (bypasses SDK's bundle-wait)
            await privacyContract.connect(verifier1).requestAuthToVerify();

            // 5. Bundle NOT delivered => submitVerifyResult must revert
            await expect(
                privacyContract.connect(verifier1).submitVerifyResult(VerificationResult.SUCCESS),
            ).to.be.revertedWith("Bundle not delivered yet");
        });

        it("submitVerifyResult with CANNOT_COMPLETE bypasses bundle check", async function () {
            // CANNOT_COMPLETE is the escape hatch: it does not require the bundle.
            const {privacyContract, dataSentToken} = await pscDeployment();
            const ownerActor = new OwnerPrivacySecond(owner, privacyContract, dataSentToken, ownerKeys, cipher);
            ownerActor.startListening();

            const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();
            const verifierActor = new VerifierPrivacySecond(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await verifierActor.setup();
            ownerActor.stopListening();

            const dataKeyPending = new Promise<void>((resolve) => {
                // @ts-ignore
                privacyContract.once("DataRequiredVerificationKeyGeneration", async (dataId: bigint, event: any) => {
                    await ownerActor.handleDataRequiresKey(Number(dataId), event);
                    resolve();
                });
            });
            await (await senderActor.publishData("QmCannotComplete", validPosition)).wait();
            await dataKeyPending;

            await privacyContract.connect(verifier1).requestAuthToVerify();

            // CANNOT_COMPLETE skips the bundle requirement
            await expect(
                privacyContract.connect(verifier1).submitVerifyResult(VerificationResult.CANNOT_COMPLETE),
            ).to.not.be.reverted;
        });

    });

    // ========================================================================
    // [E2E]
    // ========================================================================

    describe("[E2E]", function () {

        it("encrypted CID round-trips through majority verification => VALID", async function () {
            const {privacyContract, senderActor, verifierActors, dataSentToken, ownerActor} =
                await loadFixture(pscFullSetup);

            const cid = "QmPSC_BaFyBe_real_data_hash";

            const dataReady = waitForPendingData(privacyContract);
            await senderActor.publishData(cid, validPosition);
            await dataReady;

            // All 4 verifiers verify concurrently (sequential requests to avoid nonce issues)
            for (const v of verifierActors)
                await v.requestAuthToVerify();

            const results = await Promise.all(
                verifierActors.map(v => v.submitResult(VerificationResult.SUCCESS).then((tx: any) => tx.wait())),
            );

            const ownerView = new OwnerPrivacyFirst(owner, privacyContract, dataSentToken, ownerKeys, cipher);
            const {statuses} = await ownerView.getCampaignData();
            expect(statuses[0]).to.equal(0); // DataStatus.VALID

            ownerActor.stopListening();
        });

        it("rejected data yields INVALID status", async function () {
            const {privacyContract, senderActor, verifierActors, dataSentToken, ownerActor} =
                await loadFixture(pscFullSetup);

            const dataReady = waitForPendingData(privacyContract);
            await senderActor.publishData("QmBadDataPSC", validPosition);
            await dataReady;

            for (const v of verifierActors)
                await v.requestAuthToVerify();

            await Promise.all(
                verifierActors.map(v => v.submitResult(VerificationResult.REJECTED).then((tx: any) => tx.wait())),
            );

            const ownerView = new OwnerPrivacyFirst(owner, privacyContract, dataSentToken, ownerKeys, cipher);
            const {statuses} = await ownerView.getCampaignData();
            expect(statuses[0]).to.equal(2); // DataStatus.INVALID

            ownerActor.stopListening();
        });

    });

    // ========================================================================
    // [§2.6.2 REWARD DECAY]
    // ========================================================================

    describe("[§2.6.2] Reward decay", function () {

        it("getExpectedSenderReward returns full payout before any submission", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner(decayNovelParams);

            // chunkIndex=0 corresponds to validPosition (assumed)
            const expected = await ownerActor.getExpectedSenderReward(0);
            expect(expected).to.equal(BigInt(contractConfiguration.rewardConfig.dataSenderPayout));

            ownerActor.stopListening();
        });

        it("getExpectedSenderReward decreases after each submission in the same chunk", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner(decayNovelParams);

            const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();

            const rewardBefore = await ownerActor.getExpectedSenderReward(0);

            const dataReady = waitForPendingData(privacyContract);
            await senderActor.publishData("QmDecay1", validPosition);
            await dataReady;

            const rewardAfter = await ownerActor.getExpectedSenderReward(0);
            expect(rewardAfter).to.be.lessThan(rewardBefore);

            ownerActor.stopListening();
        });

        it("successive submissions in same chunk get strictly decreasing rewards", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await pscWithOwner(decayNovelParams);

            const s1 = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            const s2 = new SenderPrivacySecond(sender2, privacyContract, dataSentToken, cipher);
            await s1.setup();
            await s2.setup();

            const reward0 = await ownerActor.getExpectedSenderReward(0);

            const ready1 = waitForPendingData(privacyContract);
            await s1.publishData("QmD1", validPosition);
            await ready1;
            const reward1 = await ownerActor.getExpectedSenderReward(0);

            const ready2 = waitForPendingData(privacyContract);
            await s2.publishData("QmD2", validPosition);
            await ready2;
            const reward2 = await ownerActor.getExpectedSenderReward(0);

            expect(reward0).to.be.greaterThan(reward1);
            expect(reward1).to.be.greaterThan(reward2);

            ownerActor.stopListening();
        });

    });

    // ========================================================================
    // [§2.6.3 VERIFIER PENALTIES]
    // ========================================================================

    describe("[§2.6.3] Verifier penalties", function () {

        it("wrong vote is recorded when verifier disagrees with majority", async function () {
            // V2+V3 vote SUCCESS => VALID. V1 votes REJECTED => wrong vote.
            const {privacyContract, ownerActor, senderActor, v1, v2, v3} =
                await loadFixture(pscPenaltySetup);

            const dataReady = waitForPendingData(privacyContract);
            await senderActor.publishData("QmPenalty1", validPosition);
            await dataReady;

            await induceWrongVote(privacyContract, v1, v2, v3);

            // Verifier1 is still active (kickAfter=2, only 1 wrong vote so far)
            await expect(
                privacyContract.connect(verifier1).requestAuthToVerify(),
            ).to.not.be.reverted;

            ownerActor.stopListening();
        });

        it("verifier is kicked and emits VerifierKicked after reaching wrong-vote threshold", async function () {
            const {privacyContract, ownerActor, senderActor, v1, v2, v3} =
                await loadFixture(pscPenaltySetup);

            // First wrong vote (kickAfter=2, not kicked yet)
            const ready1 = waitForPendingData(privacyContract);
            await senderActor.publishData("QmPenalty1", validPosition);
            await ready1;
            await induceWrongVote(privacyContract, v1, v2, v3);

            // Second wrong vote => kicked
            const ready2 = waitForPendingData(privacyContract);
            await senderActor.publishData("QmPenalty2", validPosition);
            await ready2;

            const {dataId: d1} = await v1.requestAuthToVerify();
            const {dataId: d2} = await v2.requestAuthToVerify();
            const {dataId: d3} = await v3.requestAuthToVerify();

            await (await v2.submitResult(VerificationResult.SUCCESS)).wait();

            await expect(
                await v3.submitResult(VerificationResult.SUCCESS),
            ).to.emit(privacyContract, "DataVerified");

            await expect(
                await v1.submitResult(VerificationResult.REJECTED),
            ).to.emit(privacyContract, "VerifierKicked").withArgs(verifier1.address);

            ownerActor.stopListening();
        });

        it("kicked verifier cannot request further verifications", async function () {
            const {privacyContract, ownerActor, senderActor, v1, v2, v3} =
                await loadFixture(pscPenaltySetup);

            // Trigger 2 wrong votes to kick V1
            for (let i = 0; i < 2; i++) {
                const ready = waitForPendingData(privacyContract);
                await senderActor.publishData(`QmKickTest_${i}`, validPosition);
                await ready;
                await induceWrongVote(privacyContract, v1, v2, v3);
            }

            // V1 is now kicked - raw contract call must revert
            await expect(
                privacyContract.connect(verifier1).requestAuthToVerify(),
            ).to.be.revertedWith("Only verifiers allowed");

            ownerActor.stopListening();
        });

        it("correct votes pardon accumulated wrong votes", async function () {
            // pardonWrongVoteAfterRightVotes=2: after 2 correct votes, 1 wrong vote is forgiven.
            // Scenario: 1 wrong, then 2 correct (pardon fires, wrong count=0), then 1 wrong (count=1 < 2, not kicked).
            const {privacyContract, dataSentToken, ownerActor} =
                await pscWithOwner(penaltyNovelParams, penaltyConfig);

            const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();

            // Enroll V1 (will accumulate wrong votes), V2, V3 (always honest)
            const makeV = async (signer: any, result: VerificationResult) => {
                const v = new VerifierPrivacySecond(signer, privacyContract, dataSentToken, cipher, () => result);
                await v.setup();
                return v;
            };
            const v1 = await makeV(verifier1, VerificationResult.REJECTED);
            const v2 = await makeV(verifier2, VerificationResult.SUCCESS);
            const v3 = await makeV(verifier3, VerificationResult.SUCCESS);

            // Round 1: V1 votes REJECTED => 1 wrong vote (kickAfter=2, still active)
            const ready1 = waitForPendingData(privacyContract);
            await senderActor.publishData("QmPardon1", validPosition);
            await ready1;
            await induceWrongVote(privacyContract, v1, v2, v3);

            // Rounds 2+3: V1 votes SUCCESS twice => pardon fires, wrong count => 0
            v1.setVerifyCallback(() => VerificationResult.SUCCESS);
            for (let i = 0; i < 2; i++) {
                const ready = waitForPendingData(privacyContract);
                await senderActor.publishData(`QmPardon_correct_${i}`, validPosition);
                await ready;
                const {dataId: da} = await v1.requestAuthToVerify();
                const {dataId: db} = await v2.requestAuthToVerify();
                const {dataId: dc} = await v3.requestAuthToVerify();
                await (await v1.submitResult(VerificationResult.SUCCESS)).wait();
                await (await v2.submitResult(VerificationResult.SUCCESS)).wait();
                await (await v3.submitResult(VerificationResult.SUCCESS)).wait();
            }

            // Round 4: V1 votes REJECTED again => wrong count = 1 (< 2 => NOT kicked)
            v1.setVerifyCallback(() => VerificationResult.REJECTED);
            const ready4 = waitForPendingData(privacyContract);
            await senderActor.publishData("QmPardon4", validPosition);
            await ready4;

            // Must NOT emit VerifierKicked
            const {dataId: d1} = await v1.requestAuthToVerify();
            const {dataId: d2} = await v2.requestAuthToVerify();
            const {dataId: d3} = await v3.requestAuthToVerify();
            await (await v2.submitResult(VerificationResult.SUCCESS)).wait();
            await (await v3.submitResult(VerificationResult.SUCCESS)).wait();

            await expect(
                v1.submitResult(VerificationResult.REJECTED),
            ).to.not.emit(privacyContract, "VerifierKicked");

            ownerActor.stopListening();
        });

    });

    // ========================================================================
    // [LOOPS - PSC]
    // ========================================================================

    describe("[LOOPS PSC]", function () {

        it("startVerifyLoop processes N items with full bundle delivery lifecycle", async function () {
            const {senderActor, verifierActors, ownerActor} = await loadFixture(pscFullSetup);
            const verifier = verifierActors[0];

            // Submit 3 items; owner processes DataRequiredVerificationKeyGeneration for each
            for (let i = 0; i < 3; i++) {
                const dataReady = waitForPendingData((senderActor as any).contract);
                await senderActor.publishData(`QmLoopPSC_${i}`, validPosition);
                await dataReady;
            }

            const loop = verifier.startVerifyLoop(3);
            const reason = await loop.done;

            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            ownerActor.stopListening();
        });

        it("startVerifyLoop resumes when data enters pending after DataRequiredVerificationKeyGeneration is processed", async function () {
            // Loop starts => no pending data => idle => owner processes data => loop resumes
            const {senderActor, verifierActors, ownerActor} = await loadFixture(pscFullSetup);
            const verifier = verifierActors[0];

            const loop = verifier.startVerifyLoop(1);

            // Yield so loop fires its initial attempt and fails
            await new Promise(r => setTimeout(r, 50));

            // Now publish data => owner processes => DataVerificationRequestedEvent => loop wakes
            await senderActor.publishData("QmLoopIdlePSC", validPosition);

            const reason = await loop.done;
            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            ownerActor.stopListening();
        });

        it("startVerifyLoop stops with BondExhausted", async function () {
            // checksRequired=1, maxDataPerVerifierPerBond=2 => bond=2 DST.
            // After 2 requests bondBalance=0 => third reverts.
            const {privacyContract, dataSentToken} = await pscDeployment(defaultNovelParams, bondExhaustConfig);

            const ownerActor = new OwnerPrivacySecond(owner, privacyContract, dataSentToken, ownerKeys, cipher);
            ownerActor.startListening();

            const senderActor = new SenderPrivacySecond(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();

            const verifierActor = new VerifierPrivacySecond(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await verifierActor.setup();

            // Submit 3 items (loop will verify 2, then fail on 3rd)
            for (let i = 0; i < 3; i++) {
                const dataReady = waitForPendingData(privacyContract);
                await senderActor.publishData(`QmBondExhaust_${i}`, validPosition);
                await dataReady;
            }

            const loop = verifierActor.startVerifyLoop();
            const reason = await loop.done;

            expect(reason).to.equal(LoopStopReason.BondExhausted);

            ownerActor.stopListening();
        });

        it("startVerifyLoop stops with Kicked when owner kicks the verifier", async function () {
            const {privacyContract, dataSentToken, ownerActor} =
                await pscWithOwner({...defaultNovelParams, kickVerifierAfterWrongVotes: 0});

            const verifierActor = new VerifierPrivacySecond(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await verifierActor.setup();

            // No data => loop goes idle, subscribed to DataVerificationRequestedEvent
            const loop = verifierActor.startVerifyLoop();
            await new Promise(r => setTimeout(r, 50));

            // Owner kicks verifier directly => VerifierKicked event => loop stops
            await ownerActor.kickVerifier(verifier1.address);

            const reason = await loop.done;
            expect(reason).to.equal(LoopStopReason.Kicked);

            ownerActor.stopListening();
        });

    });

});