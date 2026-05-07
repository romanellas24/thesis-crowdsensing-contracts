import {loadFixture} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {expect} from "chai";
import cipher from "../testUtils/cipher";
import {
    contractDeployment,
    owner,
    ownerKeys,
    sender1,
    sender2,
    verifier1,
    verifier2,
    verifier3,
    verifier4,
    validPosition, contractConfiguration,
} from "../testUtils/constants";
import {
    OwnerPrivacyFirst,
    SenderPrivacyFirst,
    VerifierPrivacyFirst,
    VerificationResult,
} from "../src/actors";

/**
 * These tests exercise the actor SDK classes end-to-end.
 * They replace the raw `utils.setupOwnerPrivacy / setupSenderPrivacy / setupVerifierPrivacy`
 * calls with the class-based API and verify:
 *
 *  - Key exchange round-trip (PKA/PKV <-> Kenc/Kdec)
 *  - CID encryption by sender, decryption by verifier
 *  - Callback-driven verification flow
 *  - Bond deposit via actor classes
 *  - Owner auto-listener and manual fallback
 */
describe("[ACTOR CLASSES] PrivacyFirstContract", function () {

    // Shared fixture: deploy + create Owner with auto-listener
    async function deployWithOwner() {
        const {privacyContract, dataSentToken} = await loadFixture(contractDeployment);

        await dataSentToken.connect(owner).approve(
            await privacyContract.getAddress(),
            contractConfiguration.rewardConfig.totalDst,
        );
        await privacyContract.connect(owner).payInitialSupply();

        const ownerActor = new OwnerPrivacyFirst(
            owner,
            privacyContract,
            dataSentToken,
            ownerKeys,
            cipher,
        );
        ownerActor.startListening();

        return {privacyContract, dataSentToken, ownerActor};
    }

    // Fixture: owner + 1 sender enrolled & bonded
    async function withSender() {
        const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();

        const senderActor = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
        await senderActor.setup();

        return {privacyContract, dataSentToken, ownerActor, senderActor};
    }

    // Fixture: owner + 1 sender + 4 verifiers enrolled & bonded
    async function fullSetup() {
        const {privacyContract, dataSentToken, ownerActor, senderActor} = await withSender();

        const alwaysApprove = () => VerificationResult.SUCCESS;
        const verifiers = [verifier1, verifier2, verifier3, verifier4];
        const verifierActors: VerifierPrivacyFirst[] = [];
        for (const v of verifiers) {
            const actor = new VerifierPrivacyFirst(v, privacyContract, dataSentToken, cipher, alwaysApprove);
            await actor.setup();
            verifierActors.push(actor);
        }

        return {privacyContract, dataSentToken, ownerActor, senderActor, verifierActors};
    }

    // ==================================================================
    // OWNER TESTS
    // ==================================================================

    it("[OWNER]: Auto-listener handles sender enrollment", async function () {
        const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();
        const senderActor = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
        if(!ownerActor.listening)
            ownerActor.startListening();

        await senderActor.enroll();

        expect(senderActor.isEnrolled()).to.be.true;
        // Kenc must match the owner's generated encryption key
        expect(senderActor.getKenc()).to.equal(ownerActor.getEncryptionKeys().encryptionKey);
        ownerActor.stopListening();
    });

    it("[OWNER]: Auto-listener handles verifier enrollment", async function () {
        const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();
        if(!ownerActor.listening)
            ownerActor.startListening();
        const cb = () => VerificationResult.SUCCESS;
        const verifierActor = new VerifierPrivacyFirst(verifier1, privacyContract, dataSentToken, cipher, cb);

        await verifierActor.enroll();


        expect(verifierActor.isEnrolled()).to.be.true;
        expect(verifierActor.getKdec()).to.equal(ownerActor.getEncryptionKeys().decryptionKey);
        ownerActor.stopListening();
    });

    it("[OWNER]: closeCampaign works", async function () {
        const {privacyContract, ownerActor} = await deployWithOwner();
        if(!ownerActor.listening)
            ownerActor.startListening();

        await expect(ownerActor.closeCampaign())
            .to.emit(privacyContract, "CampaignClosed");
        ownerActor.stopListening();
    });

    // ==================================================================
    // SENDER TESTS
    // ==================================================================

    it("[SENDER]: setup() enrolls and pays bond", async function () {
        const {senderActor, ownerActor} = await loadFixture(withSender);
        if(!ownerActor.listening)
            ownerActor.startListening();

        expect(senderActor.isEnrolled()).to.be.true;
        ownerActor.stopListening();
    });

    it("[SENDER]: publishData encrypts CID and emits event", async function () {
        const {privacyContract, senderActor, ownerActor} = await loadFixture(withSender);
        if(!ownerActor.listening)
            ownerActor.startListening();

        await expect(senderActor.publishData("QmTestCid_1", validPosition))
            .to.emit(privacyContract, "DataVerificationRequestedEvent")
            .withArgs(0);
        ownerActor.stopListening();
    });

    it("[SENDER]: multiple data submissions increment data index", async function () {
        const {privacyContract, senderActor, ownerActor} = await loadFixture(withSender);
        if(!ownerActor.listening)
            ownerActor.startListening();

        await expect(senderActor.publishData("QmTestCid_1", validPosition))
            .to.emit(privacyContract, "DataVerificationRequestedEvent")
            .withArgs(0);
        await expect(senderActor.publishData("QmTestCid_2", validPosition))
            .to.emit(privacyContract, "DataVerificationRequestedEvent")
            .withArgs(1);
        ownerActor.stopListening();
    });

    it("[SENDER]: publishData fails before enrollment", async function () {
        const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();
        if(!ownerActor.listening)
            ownerActor.startListening();

        const raw = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
        await expect(raw.publishData("QmTest", validPosition)).to.be.rejectedWith("Not enrolled");
        ownerActor.stopListening();
    });

    // ==================================================================
    // VERIFIER TESTS
    // ==================================================================

    it("[VERIFIER]: setup() enrolls and pays bond", async function () {
        const {verifierActors, ownerActor} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();

        for (const v of verifierActors)
            expect(v.isEnrolled()).to.be.true;

        ownerActor.stopListening();
    });

    it("[VERIFIER]: requestAndVerify decrypts CID correctly", async function () {
        const {senderActor, verifierActors, ownerActor} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();

        const originalCid = "QmRealIpfsCid_abc123";
        await senderActor.publishData(originalCid, validPosition);

        const {decryptedCid, dataId, result} = await verifierActors[0].requestAndVerify();

        expect(decryptedCid).to.equal(originalCid);
        expect(dataId).to.equal(0);
        expect(result).to.equal(VerificationResult.SUCCESS);
        ownerActor.stopListening();
    });

    it("[VERIFIER]: callback drives the verification decision", async function () {
        const {senderActor, verifierActors, privacyContract, ownerActor} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();

        await senderActor.publishData("QmCid_reject_me", validPosition);

        // Override callback: reject everything
        verifierActors[0].setVerifyCallback(() => VerificationResult.REJECTED);

        const {result} = await verifierActors[0].requestAndVerify();
        expect(result).to.equal(VerificationResult.REJECTED);
        ownerActor.stopListening();
    });

    it("[VERIFIER]: manual requestAuthToVerify + submitResult works", async function () {
        const {senderActor, verifierActors, ownerActor} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();

        await senderActor.publishData("QmManualFlow", validPosition);

        const {dataId, decryptedCid} = await verifierActors[0].requestAuthToVerify();
        expect(decryptedCid).to.equal("QmManualFlow");

        await expect(verifierActors[0].submitResult(VerificationResult.SUCCESS)).to.not.be.reverted;
        ownerActor.stopListening();
    });

    // ==================================================================
    // FULL ROUND-TRIP: encryption => verification => majority => reward
    // ==================================================================

    it("[E2E]: Encrypted CID round-trips through majority verification", async function () {
        const {privacyContract, senderActor, verifierActors, dataSentToken, ownerActor} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();

        const cid = "QmBaFyBe_real_data_hash";
        await senderActor.publishData(cid, validPosition);

        let promises = [];
        for (const v of verifierActors)
            promises.push(v.requestAndVerify());

        const results = await Promise.all(promises);
        for (const resultOfPromise of results) {
            const {dataId, decryptedCid, result} = resultOfPromise;
            expect(decryptedCid).to.equal(cid);
        }

        const {statuses} = await (new OwnerPrivacyFirst(
            owner, privacyContract, dataSentToken, ownerKeys, cipher
        )).getCampaignData();

        expect(statuses[0]).to.equal(0); // VALID
        ownerActor.stopListening();
    });

    it("[E2E]: Rejected data yields INVALID status", async function () {
        const {privacyContract, senderActor, verifierActors, dataSentToken, ownerActor} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();

        await senderActor.publishData("QmBadData", validPosition);

        // Override all callbacks to REJECTED
        for (const v of verifierActors) {
            v.setVerifyCallback(() => VerificationResult.REJECTED);
        }

        for (const v of verifierActors) {
            await v.requestAndVerify();
        }

        const ownerView = new OwnerPrivacyFirst(owner, privacyContract, dataSentToken, ownerKeys, cipher);
        const {statuses} = await ownerView.getCampaignData();
        expect(statuses[0]).to.equal(2); // INVALID
        ownerActor.stopListening();
    });

    it("[E2E]: Multiple senders with distinct encrypted CIDs", async function () {
        const {privacyContract, dataSentToken, ownerActor} = await deployWithOwner();

        if(!ownerActor.listening)
            ownerActor.startListening();

        const s1 = new SenderPrivacyFirst(sender1, privacyContract, dataSentToken, cipher);
        const s2 = new SenderPrivacyFirst(sender2, privacyContract, dataSentToken, cipher);
        await s1.setup();
        await s2.setup();

        const cid1 = "QmSender1Data";
        const cid2 = "QmSender2Data";
        await s1.publishData(cid1, validPosition);
        await s2.publishData(cid2, validPosition);

        // Enroll a verifier and verify first data => should decrypt to cid1
        const v = new VerifierPrivacyFirst(
            verifier1, privacyContract, dataSentToken, cipher,
            () => VerificationResult.SUCCESS,
        );
        await v.setup();

        const first = await v.requestAuthToVerify();
        expect(first.decryptedCid).to.equal(cid1);
        await v.submitResult(VerificationResult.SUCCESS);
        ownerActor.stopListening();
    });

    // ==================================================================
    // BOND INTEGRATION
    // ==================================================================

    it("[BOND]: Sender withdraw after campaign close", async function () {
        const {privacyContract, dataSentToken, ownerActor, senderActor} = await loadFixture(withSender);
        if(!ownerActor.listening)
            ownerActor.startListening();
        const balanceBefore = await dataSentToken.balanceOf(senderActor.getAddress());

        await ownerActor.closeCampaign();
        await senderActor.withdrawBond();

        const balanceAfter = await dataSentToken.balanceOf(senderActor.getAddress());
        expect(balanceAfter).to.be.greaterThan(balanceBefore);
        ownerActor.stopListening();
    });

    it("[BOND]: Verifier withdraw after campaign close", async function () {
        const {dataSentToken, ownerActor, verifierActors} = await loadFixture(fullSetup);
        if(!ownerActor.listening)
            ownerActor.startListening();
        const v = verifierActors[0];
        const balanceBefore = await dataSentToken.balanceOf(v.getAddress());

        await ownerActor.closeCampaign();
        await v.withdrawBond();

        const balanceAfter = await dataSentToken.balanceOf(v.getAddress());
        expect(balanceAfter).to.be.greaterThan(balanceBefore);
        ownerActor.stopListening();
    });

});
