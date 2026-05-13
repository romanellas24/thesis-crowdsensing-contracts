import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { SenderPrivacySecond } from "../../src/sdk/PSC/SenderPrivacySecond";
import { VerifierPrivacySecond } from "../../src/sdk/PSC/VerifierPrivacySecond";
import { VerificationResult } from "../../src/sdk/utils/CipherProvider";
import {OwnerPrivacySecond} from "../../src/sdk/PSC/OwnerPrivacySecond";
import LoopStopReason from "../../src/sdk/utils/LoopStopReason";
import cipher from "../../testUtils/cipher";
import {ownerKeys} from "../../testUtils/constants";
import { testConfig, novelParams, validPosition, BOND_DST } from "./_helpers/testConfigs";
import { tick, waitForEventMatching } from "./_helpers/waitForEvent";

describe("[E2E] OwnerPrivacySecond - PrivacySecondContract", function () {

    async function deployFixture() {
        const [_owner, _sender, _verifier1, _verifier2, _verifierM] = await ethers.getSigners();

        const DstFactory = await ethers.getContractFactory("DataSentTokenContract");
        const dstToken = await DstFactory.connect(_owner).deploy(999_999_999n);

        const PscFactory = await ethers.getContractFactory("PrivacySecondContract");
        const contract = await PscFactory.connect(_owner).deploy(
            ownerKeys.publicKey,
            testConfig,
            await dstToken.getAddress(),
            novelParams,
        );

        for (const s of [_sender, _verifier1, _verifier2, _verifierM]) {
            await dstToken.connect(_owner).transfer(s.address, BOND_DST);
        }

        const cb = () => VerificationResult.SUCCESS;
        const cbM = () => VerificationResult.REJECTED;
        return {
            contract, dstToken,
            owner:     new OwnerPrivacySecond(_owner, contract, dstToken, ownerKeys, cipher),
            sender:    new SenderPrivacySecond(_sender, contract, dstToken, cipher),
            verifier1: new VerifierPrivacySecond(_verifier1, contract, dstToken, cipher, cb),
            verifier2: new VerifierPrivacySecond(_verifier2, contract, dstToken, cipher, cb),
            maliciousVerifier: new VerifierPrivacySecond(_verifierM, contract, dstToken, cipher, cbM),
        };
    }

    let env: Awaited<ReturnType<typeof deployFixture>>;
    beforeEach(async function () {
        env = await loadFixture(deployFixture);
        await env.owner.stopListening();
        await env.contract.removeAllListeners();
    });

    describe("trusted-verifier enrollment (2.6.1)", function () {
        it("registers the verifier on-chain without delivering Kdec, and caches PKV locally", async function () {
            await env.owner.setup();
            await env.verifier1.setup();

            // PKV must be cached on the Owner side.
            const cachedPKs: Map<string, string> = (env.owner as any).verifierPublicKeys;
            expect(cachedPKs.has(env.verifier1.getAddress())).to.equal(true);

            // The verifier is enrolled but holds no global Kdec.
            expect(env.verifier1.isEnrolled()).to.equal(true);
            expect(() => env.verifier1.getKdec()).to.throw();
        });
    });

    describe("full data flow with bundle delivery", function () {
        it("delivers the per-data bundle that lets the verifier decrypt the CID", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            const plainCid = "QmBundleFlowCid";
            const tx = await env.sender.publishData(plainCid, validPosition);
            await tx.wait();

            await tick(20_000);

            // Both verifiers run the full PSC flow: requestAuthToVerify ->
            // VerifierElectedForData -> owner builds bundle ->
            // VerifierVerificationBundleReady -> verifier decrypts.
            const r1 = await env.verifier1.requestAndVerify();
            const r2 = await env.verifier2.requestAndVerify();

            expect(r1.decryptedCid).to.equal(plainCid);
            expect(r2.decryptedCid).to.equal(plainCid);
        });

        it("frees the encryptedCidCache entry only after every assigned slot has been served", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();
            await env.maliciousVerifier.setup();

            const tx = await env.sender.publishData("QmCacheLifecycle", validPosition);
            await tx.wait();

            const cache: Map<number, string> = (env.owner as any).encryptedCidCache;
            await tick(20_000);

            // After the first verifier (1/3 served) the entry must still be there.
            await env.verifier1.requestAndVerify();
            expect(cache.has(0)).to.equal(true);

            // After the third verifier (2/3 served) the entry must still be there.
            await env.maliciousVerifier.requestAndVerify();
            expect(cache.has(0)).to.equal(true);

            // After the third verifier (3/3 served) the entry must still be there.
            await env.verifier2.requestAndVerify();
            expect(cache.has(0)).to.equal(false);
        });
    });

    describe("kickVerifier()", function () {
        it("emits VerifierKicked and stops the verifier's running loop with reason=Kicked", async function () {
            await env.owner.setup();
            await env.verifier1.setup();

            const handle = env.verifier1.startVerifyLoop();
            await tick(100);   // let the loop park on no-data

            const kickedEvP = waitForEventMatching(
                env.contract,
                "VerifierKicked",
                (verifier: string) => verifier === env.verifier1.getAddress(),
            );

            await env.owner.kickVerifier(env.verifier1.getAddress());
            await kickedEvP;

            expect(
                await handle.done
            ).to.equal(LoopStopReason.Kicked);
        });
    });

    describe("getExpectedSenderReward()", function () {
        it("returns the base payout when reward decay is disabled", async function () {
            await env.owner.setup();
            const expected = await env.owner.getExpectedSenderReward(0);
            expect(expected).to.equal(BigInt(testConfig.rewardConfig.dataSenderPayout));
        });

        it("returns a strictly decreasing value as more data fills a chunk (decay enabled)", async function () {
            // Redeploy with decay enabled for this scenario.
            const [_owner, _sender] = await ethers.getSigners();
            const DstFactory = await ethers.getContractFactory("DataSentTokenContract");
            const dst = await DstFactory.connect(_owner).deploy(999_999_999n);
            const Psc = await ethers.getContractFactory("PrivacySecondContract");
            const c = await Psc.connect(_owner).deploy(
                ownerKeys.publicKey,
                testConfig,
                await dst.getAddress(),
                { ...novelParams, rewardDecayEnabled: true, rewardDecayFactor: 2 },
            );
            await dst.connect(_owner).transfer(_sender.address, BOND_DST);

            const owner = new OwnerPrivacySecond(_owner, c, dst, ownerKeys, cipher);
            const sender = new SenderPrivacySecond(_sender, c, dst, cipher);
            await owner.setup();
            await sender.setup();

            const r0 = await owner.getExpectedSenderReward(0);

            const tx = await sender.publishData("QmDecay_1", validPosition);
            await tx.wait();
            const r1 = await owner.getExpectedSenderReward(0);

            expect(r1).to.be.lessThan(r0);

            await c.removeAllListeners();
        });
    });
});
