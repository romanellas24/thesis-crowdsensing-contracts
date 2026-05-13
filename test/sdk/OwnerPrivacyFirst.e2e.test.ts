import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
    OwnerPrivacyFirst,
    SenderPrivacyFirst,
    VerifierPrivacyFirst,
} from "../../src/sdk/PFC";
import { VerificationResult } from "../../src/sdk/utils/CipherProvider";
import cipher from "../../testUtils/cipher";
import { ownerKeys } from "../../testUtils/constants";
import { testConfig, validPosition, BOND_DST } from "./_helpers/testConfigs";
import { tick, waitForEvent } from "./_helpers/waitForEvent";

describe("[E2E] OwnerPrivacyFirst - PrivacyFirstContract", function () {

    async function deployFixture() {
        const [_owner, _sender, _verifier1, _verifier2] = await ethers.getSigners();

        const DstFactory = await ethers.getContractFactory("DataSentTokenContract");
        const dstToken = await DstFactory.connect(_owner).deploy(999_999_999n);

        const PfcFactory = await ethers.getContractFactory("PrivacyFirstContract");
        const contract = await PfcFactory.connect(_owner).deploy(
            ownerKeys.publicKey,
            testConfig,
            await dstToken.getAddress(),
        );

        // Distribute DST so senders/verifiers can pay bonds.
        for (const s of [_sender, _verifier1, _verifier2]) {
            await dstToken.connect(_owner).transfer(s.address, BOND_DST);
        }

        const callbackValid = () => VerificationResult.SUCCESS;
        const callbackInvalid = () => VerificationResult.REJECTED;

        return {
            contract, dstToken,
            owner:     new OwnerPrivacyFirst(_owner, contract, dstToken, ownerKeys, cipher),
            sender:    new SenderPrivacyFirst(_sender, contract, dstToken, cipher),
            verifier1: new VerifierPrivacyFirst(_verifier1, contract, dstToken, cipher, callbackValid),
            verifier2: new VerifierPrivacyFirst(_verifier2, contract, dstToken, cipher, callbackValid),
            // alternative verifier callbacks for INVALID-consensus tests
            mkInvalidVerifier: (idx: 1 | 2) => new VerifierPrivacyFirst(
                idx === 1 ? _verifier1 : _verifier2,
                contract, dstToken, cipher, callbackInvalid,
            ),
        };
    }

    let env: Awaited<ReturnType<typeof deployFixture>>;
    beforeEach(async function () {
        env = await loadFixture(deployFixture);
        await env.owner.stopListening();
        // loadFixture keeps the same JS contract instance across snapshots;
        // listeners survive. Strip them between tests for determinism.
        await env.contract.removeAllListeners();
    });

    describe("setup()", function () {
        it("transfers totalDst to the contract and starts listening", async function () {
            await env.owner.setup();

            expect(env.owner.listening).to.equal(true);
            const contractBalance = await env.dstToken.balanceOf(await env.contract.getAddress());
            expect(contractBalance).to.equal(BigInt(testConfig.rewardConfig.totalDst));
        });
    });

    describe("automatic enrollment via startListening()", function () {
        it("completes sender enrollment end-to-end (Kenc round-trip)", async function () {
            await env.owner.setup();
            await env.sender.setup();

            expect(env.sender.isEnrolled()).to.equal(true);

            // The Kenc the sender holds must match what the owner generated.
            const senderKenc = env.sender.getKenc();
            const ownerKenc = (env.owner as any).encryptionKeys.encryptionKey;
            expect(senderKenc).to.equal(ownerKenc);
        });

        it("completes verifier enrollment end-to-end (Kdec round-trip)", async function () {
            await env.owner.setup();
            await env.verifier1.setup();

            expect(env.verifier1.isEnrolled()).to.equal(true);

            const verifierKdec = env.verifier1.getKdec();
            const ownerKdec = (env.owner as any).encryptionKeys.decryptionKey;
            expect(verifierKdec).to.equal(ownerKdec);
        });
    });

    describe("DataVerified counters", function () {
        it("increments valid count after a VALID-consensus verification cycle", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            const tx = await env.sender.publishData("QmCidValid", validPosition);
            await tx.wait();

            // Both verifiers vote SUCCESS -> majority VALID
            const dataVerifiedP = waitForEvent(env.contract, "DataVerified");
            await env.verifier1.requestAndVerify();
            await env.verifier2.requestAndVerify();
            const [dataId, result] = await dataVerifiedP;

            expect(dataId).to.equal(0n);
            expect(result).to.equal(true);

            // Give the Owner's DataVerified listener a moment to update counters.
            await tick();
            expect(env.owner.getValidCount()).to.equal(1n);
            expect(env.owner.getInvalidCount()).to.equal(0n);
        });

        it("increments invalid count after an INVALID-consensus verification cycle", async function () {
            await env.owner.setup();
            await env.sender.setup();

            const v1 = env.mkInvalidVerifier(1);
            const v2 = env.mkInvalidVerifier(2);
            await v1.setup();
            await v2.setup();

            const tx = await env.sender.publishData("QmCidInvalid", validPosition);
            await tx.wait();

            const dataVerifiedP = waitForEvent(env.contract, "DataVerified");
            await v1.requestAndVerify();
            await v2.requestAndVerify();
            const [dataId, result] = await dataVerifiedP;

            expect(dataId).to.equal(0n);
            expect(result).to.equal(false);

            await tick();
            // EXPECTED after fixing the handleDataVerificationCompleted bug
            expect(env.owner.getInvalidCount()).to.equal(1n);
            expect(env.owner.getValidCount()).to.equal(0n);
        });
    });

    describe("stopListening()", function () {
        it("prevents the auto-handler from responding to sender enrollment", async function () {
            await env.owner.setup();
            await env.owner.stopListening();
            expect(env.owner.listening).to.equal(false);

            const settled = await Promise.race([
                env.sender.setup().then(() => "settled" as const),
                new Promise<"timeout">(r => setTimeout(() => r("timeout"), 300)),
            ]);
            expect(settled).to.equal("timeout");

            // The sender's enroll() left a one-shot listener on
            // SenderEncryptionKeyReady - clean it up to keep the next test sane.
            await env.contract.removeAllListeners();
        });
    });

    describe("closeCampaign()", function () {
        it("emits CampaignClosed and blocks further submissions", async function () {
            await env.owner.setup();
            await env.sender.setup();

            await expect(env.owner.closeCampaign())
                .to.emit(env.contract, "CampaignClosed");

            await expect(env.sender.publishData("QmAfterClose", validPosition))
                .to.be.revertedWith("Campaign is closed");
        });
    });
});
