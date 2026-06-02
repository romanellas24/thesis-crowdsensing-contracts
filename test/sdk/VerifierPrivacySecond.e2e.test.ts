import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { OwnerPrivacySecond } from "../../src/sdk/PSC/OwnerPrivacySecond";
import { SenderPrivacySecond } from "../../src/sdk/PSC/SenderPrivacySecond";
import { VerifierPrivacySecond } from "../../src/sdk/PSC/VerifierPrivacySecond";
import { VerificationResult } from "../../src/sdk/utils/CipherProvider";
import LoopStopReason from "../../src/sdk/utils/LoopStopReason";
import cipher from "../../testUtils/cipher";
import { ownerKeys } from "../../testUtils/constants";
import { testConfig, novelParams, validPosition, BOND_DST } from "./_helpers/testConfigs";
import { tick, waitForEvent } from "./_helpers/waitForEvent";

describe("[E2E] VerifierPrivacySecond - PrivacySecondContract", function () {

    async function deployFixture() {
        const [_owner, _sender, _verifier1, _verifier2] = await ethers.getSigners();

        const DstFactory = await ethers.getContractFactory("DataSentTokenContract");
        const dstToken = await DstFactory.connect(_owner).deploy(999_999_999n);

        const PscFactory = await ethers.getContractFactory("PrivacySecondContract");
        const contract = await PscFactory.connect(_owner).deploy(
            ownerKeys.publicKey,
            testConfig,
            await dstToken.getAddress(),
            novelParams,
        );

        for (const s of [_sender, _verifier1, _verifier2]) {
            await dstToken.connect(_owner).transfer(s.address, BOND_DST);
        }

        const cb = () => VerificationResult.SUCCESS;
        return {
            contract, dstToken,
            owner:     new OwnerPrivacySecond(_owner, contract, dstToken, ownerKeys, cipher),
            sender:    new SenderPrivacySecond(_sender, contract, dstToken, cipher),
            verifier1: new VerifierPrivacySecond(_verifier1, contract, dstToken, cipher, cb),
            verifier2: new VerifierPrivacySecond(_verifier2, contract, dstToken, cipher, cb),
        };
    }

    let env: Awaited<ReturnType<typeof deployFixture>>;
    beforeEach(async function () {
        env = await loadFixture(deployFixture);
        await env.owner.stopListening();
        await env.contract.removeAllListeners();
    });

    describe("enroll() override (2.6.1)", function () {
        it("registers the verifier and does NOT store a global Kdec", async function () {
            await env.owner.setup();
            await env.verifier1.enroll();

            expect(env.verifier1.isEnrolled()).to.equal(true);

            // PSC does not deliver Kdec at enrollment time. The verifier must
            // throw when asked for a global Kdec.
            expect(() => env.verifier1.getKdec()).to.throw(
                /not available on VerifierPrivacySecond/i,
            );
        });

        it("waits for the on-chain VerifierEnrolled event before resolving", async function () {
            await env.owner.setup();

            // Listen on the contract directly: the event must fire exactly once
            // for this verifier address by the time enroll() returns.
            const evP = waitForEvent(env.contract, "VerifierEnrolled");
            await env.verifier1.enroll();
            const [verifierAddr] = await evP;
            expect(verifierAddr).to.equal(env.verifier1.getAddress());
        });
    });

    describe("requestAndVerify() - bundle-driven flow", function () {
        it("decrypts the CID via the per-data bundle and submits the result", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            const plainCid = "QmPscVerifierBundle";
            const tx = await env.sender.publishData(plainCid, validPosition);
            await tx.wait();

            // The Owner's auto-listener handles the entire chain:
            //  DataRequiredVerificationKeyGeneration -> notifyVerificationKeyReady
            //  VerifierElectedForData               -> deliverVerificationBundle

            await tick(20_000);
            const r1 = await env.verifier1.requestAndVerify();

            expect(r1.decryptedCid).to.equal(plainCid);
            expect(r1.dataId).to.equal(0);
            expect(r1.result).to.equal(VerificationResult.SUCCESS);
        });

        it("propagates a callback verdict to on-chain consensus across two verifiers", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            const tx = await env.sender.publishData("QmPscConsensus", validPosition);
            await tx.wait();
            await tick(20_000);

            const dataVerifiedP = waitForEvent(env.contract, "DataVerified");
            await env.verifier1.requestAndVerify();
            await env.verifier2.requestAndVerify();
            const [, isValid] = await dataVerifiedP;

            expect(isValid).to.equal(true);
        });
    });

    describe("startVerifyLoop with Kicked", function () {
        it("exits the loop with LoopStopReason.Kicked when the verifier is kicked on-chain", async function () {
            await env.owner.setup();
            await env.verifier1.setup();

            const handle = env.verifier1.startVerifyLoop();
            await tick(100);   // let the loop park on no-data

            await env.owner.kickVerifier(env.verifier1.getAddress());

            expect(await handle.done).to.equal(LoopStopReason.Kicked);
        });

        it("processes data published while the loop is suspended on no-data", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            // Start the loops first, then publish: each loop hits "No data
            // available", parks on the notifier, and resumes when the sender
            // publishes (which triggers the chain ending in
            // DataVerificationRequestedEvent).
            const h1 = env.verifier1.startVerifyLoop(1);
            const h2 = env.verifier2.startVerifyLoop(1);
            await tick(150);

            const tx = await env.sender.publishData("QmPscWakeUp", validPosition);
            await tx.wait();

            const [r1, r2] = await Promise.all([h1.done, h2.done]);
            expect(r1).to.equal(LoopStopReason.MaxItemsReached);
            expect(r2).to.equal(LoopStopReason.MaxItemsReached);
        });
    });
});
