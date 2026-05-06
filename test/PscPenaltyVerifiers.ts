import {expect} from "chai";
import {ethers} from "hardhat";
import {loadFixture} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {contractConfiguration, ownerKeys, validPosition} from "../testUtils/constants";
import cipher from "../testUtils/cipher";

const VerificationResult = {SUCCESS: 0, FAILURE: 1, CANNOT_COMPLETE: 2};
const encryptedCid = ethers.toUtf8Bytes("encrypted_cid");

// Fixture factory
async function penaltyFixture(kickAfterWrongVotes: number, pardonWrongVoteAfterRightVotes: number) {
    const [owner, sender, v1, v2, v3] = await ethers.getSigners();

    const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenContract.deploy(999999999);

    const PrivacySecondContract = await ethers.getContractFactory("PrivacySecondContract");
    const config = {
        ...contractConfiguration,
        needs: {
            ...contractConfiguration.needs,
            checksRequired: 3,
            verifierCooldown: 1,
            maxDataPerSender: 20,
            maxDataPerVerifierPerBond: 10,
            maximumDataPerChunk: 0,
            dataNeeded: 0,
            minimumParticipants: 0,
        },
        rewardConfig: {
            ...contractConfiguration.rewardConfig,
        }
    };
    const novelParams = {
        rewardDecayEnabled: false,
        rewardDecayFactor: 1,
        kickVerifierAfterWrongVotes: kickAfterWrongVotes,
        pardonWrongVoteAfterRightVotes,
    };

    const sc = await PrivacySecondContract.deploy(
        ownerKeys.publicKey, config, await dataSentToken.getAddress(), novelParams
    );

    for (const p of [sender, v1, v2, v3]) {
        await dataSentToken.transfer(p.address, 2000);
    }
    await dataSentToken.connect(owner).approve(
        await sc.getAddress(), contractConfiguration.rewardConfig.totalDst
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
    await dataSentToken.connect(sender).approve(await sc.getAddress(), 2000);
    await sc.connect(sender).senderPayBond();

    const verifiers = [v1, v2, v3];
    const verifierKeys = [];
    for (const v of verifiers) {
        const keys = cipher.generateKeyPair();
        verifierKeys.push(keys);
        await sc.connect(v).publishEncryptedVerifierPublicKey(
            JSON.stringify(cipher.encryptStringHybrid(ownerKeys.publicKey, keys.publicKey))
        );
        await sc.connect(owner).publishVerifierDecryptionKey(v.address, "");
        await dataSentToken.connect(v).approve(await sc.getAddress(), 2000);
        await sc.connect(v).verifierPayBond();
    }

    return {sc, dataSentToken, owner, sender, verifiers, verifierKeys};
}

// Named fixtures for loadFixture
const manualKickFixture = () => penaltyFixture(0, 0);
const autoKickFixture = () => penaltyFixture(1, 0);
const pardonFixture = () => penaltyFixture(5, 2);

// ============================================================
// Helpers
// ============================================================

// Elect all 3 verifiers to a data entry and deliver bundles.
async function electAll(
    sc: any, owner: any, sender: any,
    verifiers: any[], verifierKeys: any[],
    dataId: number
) {
    await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
    await sc.connect(owner).notifyVerificationKeyReady(dataId);
    for (let i = 0; i < verifiers.length; i++) {
        await sc.connect(verifiers[i]).requestAuthToVerify();
        const bundle = ethers.toUtf8Bytes(
            JSON.stringify(cipher.encryptStringHybrid(verifierKeys[i].publicKey, "bundle"))
        );
        await sc.connect(owner).deliverVerificationBundle(dataId, verifiers[i].address, bundle);
    }
}

// V0 and V1 vote SUCCESS (majority => VALID), V2 votes FAILURE (wrong).
async function resolveWithV2WrongVote(sc: any, verifiers: any[]) {
    await sc.connect(verifiers[0]).submitVerifyResult(VerificationResult.SUCCESS);
    await sc.connect(verifiers[1]).submitVerifyResult(VerificationResult.SUCCESS);
    return sc.connect(verifiers[2]).submitVerifyResult(VerificationResult.FAILURE);
}

// All 3 verifiers vote SUCCESS.
async function resolveAllSuccess(sc: any, verifiers: any[]) {
    await sc.connect(verifiers[0]).submitVerifyResult(VerificationResult.SUCCESS);
    await sc.connect(verifiers[1]).submitVerifyResult(VerificationResult.SUCCESS);
    return sc.connect(verifiers[2]).submitVerifyResult(VerificationResult.SUCCESS);
}


// Tests
describe("PrivacySecondContract - verifier penalties", () => {

    // kickVerifier (manual)
    describe("kickVerifier", () => {

        it("[PSC] reverts if called by non-owner", async () => {
            const {sc, sender, verifiers} = await loadFixture(manualKickFixture);

            await expect(sc.connect(sender).kickVerifier(verifiers[0].address))
                .to.be.revertedWith("Not the owner");
        });

        it("[PSC] reverts if target is not a verifier", async () => {
            const {sc, owner, sender} = await loadFixture(manualKickFixture);

            await expect(sc.connect(owner).kickVerifier(sender.address))
                .to.be.revertedWith("Not a verifier");
        });

        it("[PSC] emits VerifierKicked", async () => {
            const {sc, owner, verifiers} = await loadFixture(manualKickFixture);

            await expect(sc.connect(owner).kickVerifier(verifiers[0].address))
                .to.emit(sc, "VerifierKicked")
                .withArgs(verifiers[0].address);
        });

        it("[PSC] returns remaining bond balance to verifier", async () => {
            const {sc, dataSentToken, owner, verifiers} = await loadFixture(manualKickFixture);

            const bond = await sc.getRequiredVerifierBond();
            const before = await dataSentToken.balanceOf(verifiers[0].address);
            await sc.connect(owner).kickVerifier(verifiers[0].address);
            const after = await dataSentToken.balanceOf(verifiers[0].address);

            expect(after - before).to.equal(bond);
        });

        it("[PSC] kicked verifier cannot call requestAuthToVerify", async () => {
            const {sc, owner, sender, verifiers, verifierKeys} = await loadFixture(manualKickFixture);

            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(0);

            await sc.connect(owner).kickVerifier(verifiers[0].address);

            await expect(sc.connect(verifiers[0]).requestAuthToVerify())
                .to.be.revertedWith("Only verifiers allowed");
        });

        it("[PSC] releases active slot when verifier is kicked mid-verification", async () => {
            const {sc, owner, sender, verifiers, verifierKeys} = await loadFixture(manualKickFixture);

            // Elect only V0 to dataId=0
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(0);
            await sc.connect(verifiers[0]).requestAuthToVerify();
            const bundle = ethers.toUtf8Bytes(
                JSON.stringify(cipher.encryptStringHybrid(verifierKeys[0].publicKey, "bundle"))
            );
            await sc.connect(owner).deliverVerificationBundle(0, verifiers[0].address, bundle);

            // Kick V0 while it is verifying
            await sc.connect(owner).kickVerifier(verifiers[0].address);

            // V1 should now be able to get elected to the same slot (expired/cleared)
            await sc.connect(verifiers[1]).requestAuthToVerify();
            const bundle2 = ethers.toUtf8Bytes(
                JSON.stringify(cipher.encryptStringHybrid(verifierKeys[1].publicKey, "bundle"))
            );
            await expect(sc.connect(owner).deliverVerificationBundle(0, verifiers[1].address, bundle2))
                .to.emit(sc, "VerifierVerificationBundleReady");
        });
    });

    // Auto-kick
    describe("automatic kick", () => {

        it("[PSC] kicks verifier automatically after reaching wrong votes threshold", async () => {
            const {sc, owner, sender, verifiers, verifierKeys} = await loadFixture(autoKickFixture);

            await electAll(sc, owner, sender, verifiers, verifierKeys, 0);

            await expect(resolveWithV2WrongVote(sc, verifiers))
                .to.emit(sc, "VerifierKicked")
                .withArgs(verifiers[2].address);
        });

        it("[PSC] auto-kicked verifier cannot requestAuthToVerify", async () => {
            const {sc, owner, sender, verifiers, verifierKeys} = await loadFixture(autoKickFixture);

            await electAll(sc, owner, sender, verifiers, verifierKeys, 0);
            await resolveWithV2WrongVote(sc, verifiers);

            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(1);

            await expect(sc.connect(verifiers[2]).requestAuthToVerify())
                .to.be.revertedWith("Only verifiers allowed");
        });

        it("[PSC] does not kick when kickVerifierAfterWrongVotes = 0", async () => {
            const {sc, owner, sender, verifiers, verifierKeys} = await loadFixture(manualKickFixture);

            await electAll(sc, owner, sender, verifiers, verifierKeys, 0);

            await expect(await resolveWithV2WrongVote(sc, verifiers))
                .to.not.emit(sc, "VerifierKicked");

            // V2 still active
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(1);
            await expect(sc.connect(verifiers[2]).requestAuthToVerify())
                .to.emit(sc, "VerifierElectedForData");
        });
    });

    // Pardon mechanism
    describe("pardon mechanism", () => {

        // pardonFixture: kickAfterWrongVotes=5, pardonWrongVoteAfterRightVotes=2
        // V2 gets 1 wrong vote, then 2 correct votes => wrong count goes back to 0
        // then gets another wrong vote => still at 1, not kicked (threshold is 5)
        // without pardon it would be at 2 after 2 wrong votes

        it("[PSC] decrements wrong vote counter after n correct votes", async () => {
            const {sc, owner, sender, verifiers, verifierKeys} = await loadFixture(pardonFixture);

            // Round 0: V2 votes wrong (wrongVotes=1)
            await electAll(sc, owner, sender, verifiers, verifierKeys, 0);
            await resolveWithV2WrongVote(sc, verifiers);

            // Round 1: all vote correctly for V2 (rightVotesAccumulator=1)
            await electAll(sc, owner, sender, verifiers, verifierKeys, 1);
            await resolveAllSuccess(sc, verifiers);

            // Round 2: all vote correctly for V2 (accumulator=2 >= pardon=2 => wrongVotes=0)
            await electAll(sc, owner, sender, verifiers, verifierKeys, 2);
            await resolveAllSuccess(sc, verifiers);

            // Now wrongVotes=0. Get 5 more wrong votes - should be kicked only after 5th.
            // If pardon didn't work, we'd already be at wrongVotes=1 and need only 4 more.
            // With pardon working, we need 5 wrong votes from scratch.
            // We verify this by checking V2 survives 4 more wrong votes.
            for (let i = 3; i < 7; i++) {
                await electAll(sc, owner, sender, verifiers, verifierKeys, i);
                const tx = resolveWithV2WrongVote(sc, verifiers);
                if (i < 7) {
                    await expect(tx).to.not.emit(sc, "VerifierKicked");
                }
            }

            // 5th wrong vote after pardon => kicked
            await electAll(sc, owner, sender, verifiers, verifierKeys, 7);
            await expect(resolveWithV2WrongVote(sc, verifiers))
                .to.emit(sc, "VerifierKicked")
                .withArgs(verifiers[2].address);
        });

        it("[PSC] does not pardon when pardonWrongVoteAfterRightVotes = 0", async () => {
            // kickAfterWrongVotes=2, pardonWrongVoteAfterRightVotes=0
            const fixture = () => penaltyFixture(2, 0);
            const {sc, owner, sender, verifiers, verifierKeys} = await fixture();

            // Round 0: V2 votes wrong (wrongVotes=1)
            await electAll(sc, owner, sender, verifiers, verifierKeys, 0);
            await resolveWithV2WrongVote(sc, verifiers);

            // Round 1: V2 votes correctly - pardon disabled, wrongVotes stays at 1
            await electAll(sc, owner, sender, verifiers, verifierKeys, 1);
            await resolveAllSuccess(sc, verifiers);

            // Round 2: V2 votes wrong again (wrongVotes=2 => kick)
            await electAll(sc, owner, sender, verifiers, verifierKeys, 2);
            await expect(resolveWithV2WrongVote(sc, verifiers))
                .to.emit(sc, "VerifierKicked")
                .withArgs(verifiers[2].address);
        });
    });
});