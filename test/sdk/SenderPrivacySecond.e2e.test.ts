import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { OwnerPrivacySecond } from "../../src/sdk/PSC/OwnerPrivacySecond";
import { SenderPrivacySecond } from "../../src/sdk/PSC/SenderPrivacySecond";
import cipher from "../../testUtils/cipher";
import { ownerKeys } from "../../testUtils/constants";
import { testConfig, novelParams, validPosition, BOND_DST } from "./_helpers/testConfigs";
import {eventFiresWithin, tick, waitForEvent} from "./_helpers/waitForEvent";

/**
 * SenderPrivacySecond is intentionally a thin extension of SenderPrivacyFirst
 * (2.6.2 reward decay is on-chain). These tests verify that:
 *  - The inherited enrollment + bond + publish flow works against PSC.
 *  - publishData triggers the PSC-specific DataRequiredVerificationKeyGeneration
 *    event - the protocol invariant that distinguishes PSC from PFC at
 *    submission time.
 *  - The encrypted CID submitted on-chain round-trips through Kenc/Kdec.
 */

describe("[E2E] SenderPrivacySecond - PrivacySecondContract", function () {

    async function deployFixture() {
        const [_owner, _sender] = await ethers.getSigners();

        const DstFactory = await ethers.getContractFactory("DataSentTokenContract");
        const dstToken = await DstFactory.connect(_owner).deploy(999_999_999n);

        const PscFactory = await ethers.getContractFactory("PrivacySecondContract");
        const contract = await PscFactory.connect(_owner).deploy(
            ownerKeys.publicKey,
            testConfig,
            await dstToken.getAddress(),
            novelParams,
        );

        await dstToken.connect(_owner).transfer(_sender.address, BOND_DST);

        return {
            contract, dstToken,
            owner:  new OwnerPrivacySecond(_owner, contract, dstToken, ownerKeys, cipher),
            sender: new SenderPrivacySecond(_sender, contract, dstToken, cipher),
        };
    }

    let env: Awaited<ReturnType<typeof deployFixture>>;
    beforeEach(async function () {
        env = await loadFixture(deployFixture);
        //@ts-ignore
        env.sender._enrolled = false;
        await env.owner.stopListening();
        await env.contract.removeAllListeners();
    });

    describe("inherited enrollment on PSC", function () {
        it("completes the key exchange and obtains Kenc against PrivacySecondContract", async function () {
            await env.owner.setup();
            await env.sender.setup();

            expect(env.sender.isEnrolled()).to.equal(true);
            expect(env.sender.getKenc()).to.equal(
                (env.owner as any).encryptionKeys.encryptionKey,
            );
        });
    });

    describe("publishData() in the PSC submission flow", function () {
        it("triggers DataRequiredVerificationKeyGeneration (the PSC kickoff event)", async function () {
            // Enroll the sender via auto-listener, then stop listening so the
            // Owner does NOT auto-call notifyVerificationKeyReady on submission.
            // This lets us assert the PSC-specific event in isolation.
            await env.owner.setup();
            await env.sender.setup();
            await env.owner.stopListening();
            await env.contract.removeAllListeners();

            const dataReqP = waitForEvent(env.contract, "DataRequiredVerificationKeyGeneration");
            const tx = await env.sender.publishData("QmPscSubmit", validPosition);
            await tx.wait();

            const [dataId] = await dataReqP;
            expect(dataId).to.equal(0n);

            // With the Owner not listening, notifyVerificationKeyReady must NOT
            // have been called, so DataVerificationRequestedEvent stays silent.
            const result = await eventFiresWithin(env.contract, "DataVerificationRequestedEvent", 300);
            expect(result).to.equal("silent");
        });

        it("submits a CID that the owner can decrypt back to the plaintext", async function () {
            await env.owner.setup();
            await env.sender.setup();

            const plainCid = "QmSecondRoundTrip";
            const tx = await env.sender.publishData(plainCid, validPosition);
            await tx.wait();

            // The Owner caches the encrypted CID when DataRequiredVerificationKeyGeneration
            // fires. Give the handler a tick to run.
            await tick(200);

            const cache: Map<number, string> = (env.owner as any).encryptedCidCache;
            const encryptedHex = cache.get(0);
            expect(encryptedHex, "Owner did not cache the encrypted CID").to.exist;

            const ownerKdec = (env.owner as any).encryptionKeys.decryptionKey;
            const envelopeJson = encryptedHex!;
            const decrypted = cipher.decryptStringHybrid(ownerKdec, JSON.parse(envelopeJson));
            expect(decrypted).to.equal(plainCid);
        });

        it("rejects submissions when the campaign is closed", async function () {
            await env.owner.setup();
            await env.sender.setup();

            await env.owner.closeCampaign();

            await expect(env.sender.publishData("QmAfterClose", validPosition))
                .to.be.revertedWith("Campaign is closed");
        });
    });
});
