import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
    OwnerPrivacyFirst,
    SenderPrivacyFirst,
    VerifierPrivacyFirst,
} from "../../src/sdk/PFC";
import { VerificationResult } from "../../src/sdk/utils/CipherProvider";
import LoopStopReason from "../../src/sdk/utils/LoopStopReason";
import cipher from "../../testUtils/cipher";
import {owner, ownerKeys} from "../../testUtils/constants";
import { testConfig, validPosition, BOND_DST } from "./_helpers/testConfigs";
import { tick, waitForEvent } from "./_helpers/waitForEvent";

describe("[E2E] VerifierPrivacyFirst - PrivacyFirstContract", function () {

    async function deployFixture() {
        const [_owner, _sender, _verifier1, _verifier2, _verifier3] = await ethers.getSigners();

        const DstFactory = await ethers.getContractFactory("DataSentTokenContract");
        const dstToken = await DstFactory.connect(_owner).deploy(999_999_999n);

        const PfcFactory = await ethers.getContractFactory("PrivacyFirstContract");
        const contract = await PfcFactory.connect(_owner).deploy(
            ownerKeys.publicKey,
            testConfig,
            await dstToken.getAddress(),
        );

        for (const s of [_sender, _verifier1, _verifier2, _verifier3]) {
            await dstToken.connect(_owner).transfer(s.address, BOND_DST);
        }

        const cbSuccess  = () => VerificationResult.SUCCESS;
        const cbReject   = () => VerificationResult.REJECTED;
        const cbCantDo   = () => VerificationResult.CANNOT_COMPLETE;

        return {
            contract, dstToken,
            owner:     new OwnerPrivacyFirst(_owner, contract, dstToken, ownerKeys, cipher),
            sender:    new SenderPrivacyFirst(_sender, contract, dstToken, cipher),
            verifier1: new VerifierPrivacyFirst(_verifier1, contract, dstToken, cipher, cbSuccess),
            verifier2: new VerifierPrivacyFirst(_verifier2, contract, dstToken, cipher, cbSuccess),
            verifier3: new VerifierPrivacyFirst(_verifier3, contract, dstToken, cipher, cbReject),
            cbCantDo,
        };
    }

    let env: Awaited<ReturnType<typeof deployFixture>>;
    beforeEach(async function () {
        env = await loadFixture(deployFixture);
        await env.owner.stopListening();
        await env.contract.removeAllListeners();
    });

    describe("enroll()", function () {
        it("completes the handshake and stores Kdec matching the owner's Kdec", async function () {
            await env.owner.setup();
            await env.verifier1.enroll();

            expect(env.verifier1.isEnrolled()).to.equal(true);
            expect(env.verifier1.getKdec()).to.equal(
                (env.owner as any).encryptionKeys.decryptionKey,
            );
        });
    });

    describe("payBond()", function () {
        it("moves the required bond from the verifier to the contract", async function () {
            await env.owner.setup();
            await env.verifier1.enroll();

            const required = await env.contract.getRequiredVerifierBond();
            const before = await env.dstToken.balanceOf(env.verifier1.getAddress());

            await env.verifier1.payBond();

            const after = await env.dstToken.balanceOf(env.verifier1.getAddress());
            expect(before - after).to.equal(required);
        });
    });

    describe("requestAndVerify()", function () {
        it("calls the user callback with the decrypted CID and submits the result", async function () {
            await env.owner.setup();
            await env.sender.setup();

            // Use a verifier with an inspectable callback so we can assert
            // what the SDK passed to it.
            const [, , _v1] = await ethers.getSigners();
            let observedCid = "";
            let observedDataId = -1;
            const inspect = new VerifierPrivacyFirst(
                _v1, env.contract, env.dstToken, cipher,
                (cid, dataId) => {
                    observedCid = cid;
                    observedDataId = dataId;
                    return VerificationResult.SUCCESS;
                },
            );
            await inspect.setup();

            const plainCid = "QmObservedByCallback";
            const tx = await env.sender.publishData(plainCid, validPosition);
            await tx.wait();

            const { dataId, decryptedCid, result } = await inspect.requestAndVerify();

            expect(decryptedCid).to.equal(plainCid);
            expect(observedCid).to.equal(plainCid);
            expect(observedDataId).to.equal(dataId);
            expect(result).to.equal(VerificationResult.SUCCESS);
        });

        it("reaches VALID consensus when both verifiers vote SUCCESS", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            const tx = await env.sender.publishData("QmConsensusValid", validPosition);
            await tx.wait();

            const dataVerifiedP = waitForEvent(env.contract, "DataVerified");
            await env.verifier1.requestAndVerify();
            await env.verifier2.requestAndVerify();
            const [, isValid] = await dataVerifiedP;

            expect(isValid).to.equal(true);
        });

        it("reaches INVALID consensus when both verifiers vote REJECTED", async function () {
            await env.owner.setup();
            await env.sender.setup();

            // Two REJECT-voting verifiers.
            const [, , _v1, _v2] = await ethers.getSigners();
            const reject1 = new VerifierPrivacyFirst(
                _v1, env.contract, env.dstToken, cipher,
                () => VerificationResult.REJECTED,
            );
            const reject2 = new VerifierPrivacyFirst(
                _v2, env.contract, env.dstToken, cipher,
                () => VerificationResult.REJECTED,
            );
            await reject1.setup();
            await reject2.setup();

            const tx = await env.sender.publishData("QmConsensusInvalid", validPosition);
            await tx.wait();

            const dataVerifiedP = waitForEvent(env.contract, "DataVerified");
            await reject1.requestAndVerify();
            await reject2.requestAndVerify();
            const [, isValid] = await dataVerifiedP;

            expect(isValid).to.equal(false);
        });
    });

    describe("startVerifyLoop()", function () {
        it("processes all queued data and stops with MaxItemsReached", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            // Publish 3 data and limit each verifier loop to 3 items.
            for (let i = 0; i < 3; i++) {
                const tx = await env.sender.publishData(`QmLoop_${i}`, validPosition);
                await tx.wait();
            }

            const h1 = env.verifier1.startVerifyLoop(3);
            const h2 = env.verifier2.startVerifyLoop(3);

            const [r1, r2] = await Promise.all([h1.done, h2.done]);
            expect(r1).to.equal(LoopStopReason.MaxItemsReached);
            expect(r2).to.equal(LoopStopReason.MaxItemsReached);
        });

        it("suspends on 'no data' then resumes when new data arrives", async function () {
            await env.owner.setup();
            await env.sender.setup();
            await env.verifier1.setup();
            await env.verifier2.setup();

            // Start the loops with maxItems = 1 BEFORE any data is published.
            // They will immediately get "No data available" and park on notifier.wait().
            const h1 = env.verifier1.startVerifyLoop(1);
            const h2 = env.verifier2.startVerifyLoop(1);

            // Give the loops a moment to enter the parked state.
            await tick(150);

            // Publish a datum: the contract fires DataVerificationRequestedEvent,
            // both loops wake up, one of them gets the slot (and the second too,
            // since checksRequired = 2), each completes their single item.
            const tx = await env.sender.publishData("QmWakeMeUp", validPosition);
            await tx.wait();

            const [r1, r2] = await Promise.all([h1.done, h2.done]);
            expect(r1).to.equal(LoopStopReason.MaxItemsReached);
            expect(r2).to.equal(LoopStopReason.MaxItemsReached);
        });

        it("stops with ManualStop when handle.stop() is called", async function () {
            await env.owner.setup();
            await env.verifier1.setup();

            const handle = env.verifier1.startVerifyLoop();
            await tick(100);          // let it park on no-data
            handle.stop();

            expect(await handle.done).to.equal(LoopStopReason.ManualStop);
        });
    });
});
