import {loadFixture} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import {ethers} from "hardhat";
import cipher from "../testUtils/cipher";

import {
    contractConfiguration,
    contractDeployment,
    owner,
    ownerKeys,
    sender1,
    sender2,
    validPosition,
    verifier1,
    verifier2,
    verifier3,
} from "../testUtils/constants";
import {OwnerPrivacyFirst, SenderPrivacyFirst, VerificationResult, VerifierPrivacyFirst,} from "../src/actors/PFC";
import LoopStopReason from "../src/actors/PFC/LoopStopReason";

// ---------------------------------------------------------------------------
// Custom configs for edge-case loop tests
// ---------------------------------------------------------------------------

/**
 * Bond exhaustion:
 *   - checksRequired=1 => single verifier decides
 *   - maxDataPerVerifierPerBond=2 => bond = 2 DST
 *   After 2 requests bondBalance=0 regardless of outcome (rewards go to wallet,
 *   not back to bondBalance). Third request => "Insufficient DST balance in bond".
 */
const bondExhaustConfig = {
    ...contractConfiguration,
    needs: {
        ...contractConfiguration.needs,
        checksRequired: 1,
        maxDataPerVerifierPerBond: 2,
        dataNeeded: 0,          // no auto-close by data count
        minimumParticipants: 0,
    },
};

/**
 * Campaign auto-close:
 *   - checksRequired=1, dataNeeded=1, minimumParticipants=1
 *   => campaign closes after 1 verified VALID datum.
 *   Loop processes it, then tries again => "Campaign is closed".
 */
const autoCloseConfig = {
    ...contractConfiguration,
    needs: {
        ...contractConfiguration.needs,
        checksRequired: 1,
        dataNeeded: 1,
        minimumParticipants: 1,
        maxDataPerVerifierPerBond: 5,
    },
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function deployWithOwner() {
    const {privacyContract, dataSentToken} = await contractDeployment();
    const ownerActor = new OwnerPrivacyFirst(owner, privacyContract, dataSentToken, ownerKeys, cipher);
    ownerActor.startListening();
    return {privacyContract, dataSentToken, ownerActor};
}

async function deployWithCustomConfig(config: typeof contractConfiguration) {
    const [_owner, _s1, _s2, _s3, _v1, _v2, _v3, _v4] = await ethers.getSigners();
    const DataSentTokenFactory = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenFactory.deploy(999_999_999);

    const PFCFactory = await ethers.getContractFactory("PrivacyFirstContract");
    const privacyContract = await PFCFactory.connect(_owner).deploy(
        ownerKeys.publicKey,
        config,
        await dataSentToken.getAddress(),
    );

    for (const user of [_s1, _v1, _v2, _v3, _v4]) {
        await dataSentToken.transfer(await user.getAddress(), 100);
    }
    await dataSentToken.connect(_owner).approve(
        await privacyContract.getAddress(),
        config.rewardConfig.totalDst,
    );
    await privacyContract.connect(_owner).payInitialSupply();

    return {privacyContract, dataSentToken};
}

// Full loop setup: owner + 1 sender + 1 verifier enrolled & bonded
async function loopReady() {
    const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();

    const senderActor = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
    await senderActor.setup();

    const verifierActor1 = new VerifierPrivacyFirst(
        verifier1, privacyContract, dataSentToken, cipher,
        () => VerificationResult.SUCCESS,
    );
    await verifierActor1.setup();

    const verifierActor2 = new VerifierPrivacyFirst(
        verifier2, privacyContract, dataSentToken, cipher,
        () => VerificationResult.SUCCESS,
    );
    await verifierActor2.setup();

    const verifierActor3 = new VerifierPrivacyFirst(
        verifier3, privacyContract, dataSentToken, cipher,
        () => VerificationResult.SUCCESS,
    );
    await verifierActor3.setup();

    return {privacyContract, dataSentToken, ownerActor, senderActor, verifierActor1, verifierActor2, verifierActor3};
}

// ============================================================================

describe("[ACTOR CLASSES] PrivacyFirstContract - Loops", function () {

    // ========================================================================
    // waitForEnrollments
    // ========================================================================

    describe("waitForEnrollments", function () {

        it("resolves after N senders complete enrollment", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();

            const wait = ownerActor.waitForEnrollments(2, 0);

            const s1 = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
            const s2 = new SenderPrivacyFirst(sender2, privacyContract, dataSentToken, cipher);
            await s1.enroll();
            await s2.enroll();

            // Should resolve - if it hangs, Mocha timeout will catch it
            await wait;

            expect(s1.isEnrolled()).to.be.true;
            expect(s2.isEnrolled()).to.be.true;

            ownerActor.stopListening();
        });

        it("resolves after N verifiers complete enrollment", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();

            const wait = ownerActor.waitForEnrollments(0, 2);

            const v1 = new VerifierPrivacyFirst(verifier1, privacyContract, dataSentToken, cipher, () => VerificationResult.SUCCESS);
            const v2 = new VerifierPrivacyFirst(verifier2, privacyContract, dataSentToken, cipher, () => VerificationResult.SUCCESS);
            await v1.enroll();
            await v2.enroll();

            await wait;

            expect(v1.isEnrolled()).to.be.true;
            expect(v2.isEnrolled()).to.be.true;

            ownerActor.stopListening();
        });

        it("resolves only after both sender and verifier targets are met", async function () {
            const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();

            // Target: 1 sender AND 1 verifier
            const wait = ownerActor.waitForEnrollments(1, 1);

            const s = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
            const v = new VerifierPrivacyFirst(verifier1, privacyContract, dataSentToken, cipher, () => VerificationResult.SUCCESS);

            // Enroll only sender first - promise must not resolve yet
            await s.enroll();
            let resolved = false;
            wait.then(() => { resolved = true; });
            await Promise.resolve(); // flush microtasks
            expect(resolved).to.be.false;

            // Now enroll verifier - promise resolves
            await v.enroll();
            await wait;

            ownerActor.stopListening();
        });

        it("resolves immediately when both targets are 0", async function () {
            const {ownerActor} = await deployWithOwner();
            // Must not hang
            await ownerActor.waitForEnrollments(0, 0);
            ownerActor.stopListening();
        });

    });

    // ========================================================================
    // startVerifyLoop
    // ========================================================================

    describe("startVerifyLoop", function () {

        it("stops with MaxItemsReached after processing N items", async function () {
            const {senderActor, verifierActor1, ownerActor} = await loadFixture(loopReady);
            const verifierActor = verifierActor1;
            if(!ownerActor.listening)
                ownerActor.startListening();

            // Submit 3 data items upfront
            for (let i = 0; i < 3; i++)
                await (await senderActor.publishData(`QmLoop_${i}`, validPosition)).wait();

            const loop = verifierActor.startVerifyLoop(3);
            const reason = await loop.done;

            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            ownerActor.stopListening();
        });

        it("goes idle when no data, resumes on DataVerificationRequestedEvent", async function () {
            const {senderActor, verifierActor1, ownerActor} = await loadFixture(loopReady);
            const verifierActor = verifierActor1;

            if(!ownerActor.listening)
                ownerActor.startListening();

            // Start loop with no data - initial attempt fails, loop subscribes to event
            const loop = verifierActor.startVerifyLoop(1);

            // Yield so runAttempt fires and fails ("No data available")
            await new Promise(r => setTimeout(r, 50));

            // Now submit data - emits DataVerificationRequestedEvent => loop wakes up
            await (await senderActor.publishData("QmIdle", validPosition)).wait();

            const reason = await loop.done;
            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            ownerActor.stopListening();
        });

        it("handles DataVerificationRequestedEvent arriving mid-verification (pendingAttempt)", async function () {
            const {senderActor, verifierActor1, verifierActor2, verifierActor3, ownerActor} = await loadFixture(loopReady);
            if(!ownerActor.listening)
                ownerActor.startListening();


            await (await senderActor.publishData("QmA", validPosition)).wait();
            await (await senderActor.publishData("QmB", validPosition)).wait();
            await (await senderActor.publishData("QmC", validPosition)).wait();
            await (await senderActor.publishData("QmD", validPosition)).wait();


            const loop1 = verifierActor1.startVerifyLoop(2);
            const loop2 = verifierActor2.startVerifyLoop(1);
            const loop3 = verifierActor3.startVerifyLoop(1);

            let reason = await loop1.done;

            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            reason = await loop2.done;
            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            reason = await loop3.done;
            expect(reason).to.equal(LoopStopReason.MaxItemsReached);

            ownerActor.stopListening();
        });

        it("stops with BondExhausted when bondBalance reaches 0", async function () {
            // Custom config: checksRequired=1, maxDataPerVerifierPerBond=2
            // => bond = 2 DST. After 2 requests bondBalance=0; third fails.
            const {privacyContract, dataSentToken} = await deployWithCustomConfig(bondExhaustConfig);

            const ownerActor = new OwnerPrivacyFirst(owner, privacyContract, dataSentToken, ownerKeys, cipher);
            ownerActor.startListening();

            const senderActor = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();

            const verifierActor = new VerifierPrivacyFirst(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await verifierActor.setup();

            // 3 items: loop verifies 2 (bond exhausted after slot 0 + slot 1 requests),
            // third attempt reverts "Insufficient DST balance in bond"
            for (let i = 0; i < 3; i++)
                await (await senderActor.publishData(`QmBond_${i}`, validPosition)).wait();

            const loop = verifierActor.startVerifyLoop();
            const reason = await loop.done;

            expect(reason).to.equal(LoopStopReason.BondExhausted);

            ownerActor.stopListening();
        });

        it("stops with CampaignClosed when campaign auto-closes after final datum", async function () {
            // Custom config: checksRequired=1, dataNeeded=1, minimumParticipants=1
            // After 1 valid datum the campaign closes.
            // The loop verifies it (success), then tries again => "Campaign is closed".
            const {privacyContract, dataSentToken} = await deployWithCustomConfig(autoCloseConfig);

            const ownerActor = new OwnerPrivacyFirst(owner, privacyContract, dataSentToken, ownerKeys, cipher);
            ownerActor.startListening();

            const senderActor = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
            await senderActor.setup();

            const verifierActor = new VerifierPrivacyFirst(
                verifier1, privacyContract, dataSentToken, cipher,
                () => VerificationResult.SUCCESS,
            );
            await verifierActor.setup();

            // Submit 2 items; loop will verify the first (campaign closes), then attempt
            // the second and hit "Campaign is closed"
            for (let i = 0; i < 2; i++)
                await (await senderActor.publishData(`QmClose_${i}`, validPosition)).wait();

            const loop = verifierActor.startVerifyLoop();
            const reason = await loop.done;

            expect(reason).to.equal(LoopStopReason.CampaignClosed);

            ownerActor.stopListening();
        });

        it("stops with ManualStop when stop() is called", async function () {
            const {verifierActor1, ownerActor} = await loadFixture(loopReady);
            // No data - loop goes idle
            const loop = verifierActor1.startVerifyLoop();
            await new Promise(r => setTimeout(r, 50));

            loop.stop();
            const reason = await loop.done;

            expect(reason).to.equal(LoopStopReason.ManualStop);

            ownerActor.stopListening();
        });

        it("done resolves only once even if stop() is called redundantly", async function () {
            const {verifierActor1, ownerActor} = await loadFixture(loopReady);
            const loop = verifierActor1.startVerifyLoop();
            await new Promise(r => setTimeout(r, 20));

            loop.stop();
            loop.stop(); // idempotent - must not throw or double-resolve

            const reason = await loop.done;
            expect(reason).to.equal(LoopStopReason.ManualStop);

            ownerActor.stopListening();
        });

    });
});