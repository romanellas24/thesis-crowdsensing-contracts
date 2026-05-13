import {expect} from "chai";
import {ethers} from "hardhat";
import {loadFixture} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {contractConfiguration, ownerKeys, validPosition} from "../testUtils/constants";
import cipher from "../testUtils/cipher";

const VerificationResult = {SUCCESS: 0, FAILURE: 1, CANNOT_COMPLETE: 2};

const encryptedCid = ethers.toUtf8Bytes("encrypted_cid");

async function secondContractFixture() {
    const [owner, sender, verifier] = await ethers.getSigners();

    const DataSentTokenContract = await ethers.getContractFactory("DataSentTokenContract");
    const dataSentToken = await DataSentTokenContract.deploy(999999999);

    const PrivacySecondContract = await ethers.getContractFactory("PrivacySecondContract");

    const novelParams = {
        rewardDecayEnabled: false,
        rewardDecayFactor: 0,
        kickVerifierAfterWrongVotes: 0,
        pardonWrongVoteAfterRightVotes: 0,
    };

    const sc = await PrivacySecondContract.deploy(
        ownerKeys.publicKey,
        contractConfiguration,
        await dataSentToken.getAddress(),
        novelParams
    );

    await dataSentToken.transfer(sender.address, 100);
    await dataSentToken.transfer(verifier.address, 100);
    await dataSentToken.connect(owner).approve(
        await sc.getAddress(),
        contractConfiguration.rewardConfig.totalDst
    );
    await sc.connect(owner).payInitialSupply();

    // Enroll sender - hybrid perché PEM (~800 bytes) supera il limite RSA-OAEP
    const senderKeys = cipher.generateKeyPair();
    const encSenderPubKey = JSON.stringify(
        cipher.encryptStringHybrid(ownerKeys.publicKey, senderKeys.publicKey)
    );
    await sc.connect(sender).publishEncryptedSenderPublicKey(encSenderPubKey);
    const encKenc = JSON.stringify(
        cipher.encryptStringHybrid(senderKeys.publicKey, "kenc_placeholder")
    );
    await sc.connect(owner).publishSenderEncryptionKey(sender.address, encKenc);
    await dataSentToken.connect(sender).approve(await sc.getAddress(), 100);
    await sc.connect(sender).senderPayBond();

    // Enroll verifier - novel protocol: nessuna chiave all'enrollment
    const verifierKeys = cipher.generateKeyPair();
    const encVerifierPubKey = JSON.stringify(
        cipher.encryptStringHybrid(ownerKeys.publicKey, verifierKeys.publicKey)
    );
    await sc.connect(verifier).publishEncryptedVerifierPublicKey(encVerifierPubKey);
    await sc.connect(owner).publishVerifierDecryptionKey(verifier.address, "");
    await dataSentToken.connect(verifier).approve(await sc.getAddress(), 100);
    await sc.connect(verifier).verifierPayBond();

    return {sc, dataSentToken, owner, sender, verifier, verifierKeys};
}

async function electedVerifierFixture() {
    const ctx = await secondContractFixture();
    await ctx.sc.connect(ctx.sender).publishIpfsCid(encryptedCid, validPosition);
    await ctx.sc.connect(ctx.owner).notifyVerificationKeyReady(0);
    await ctx.sc.connect(ctx.verifier).requestAuthToVerify();
    return ctx;
}

describe("PrivacySecondContract - Trusted verifiers", () => {

    let env: Awaited<ReturnType<typeof secondContractFixture>>;
    beforeEach(async function () {
        env = await loadFixture(secondContractFixture);
        await env.sc.removeAllListeners();
    });

    // publishVerifierDecryptionKey
    describe("[PSC] publishVerifierDecryptionKey", () => {

        it("[PSC] emits VerifierEnrolled", async () => {
            const {sc, owner} = await loadFixture(secondContractFixture);
            const [,,,, freshVerifier] = await ethers.getSigners();

            const freshKeys = cipher.generateKeyPair();
            const encPubKey = JSON.stringify(
                cipher.encryptStringHybrid(ownerKeys.publicKey, freshKeys.publicKey)
            );
            await sc.connect(freshVerifier).publishEncryptedVerifierPublicKey(encPubKey);

            await expect(sc.connect(owner).publishVerifierDecryptionKey(freshVerifier.address, ""))
                .to.emit(sc, "VerifierEnrolled")
                .withArgs(freshVerifier.address);
        });

        it("[PSC] does NOT emit VerifierDecryptionKeyReady", async () => {
            const {sc, owner} = await loadFixture(secondContractFixture);
            const [,,,, freshVerifier] = await ethers.getSigners();

            const freshKeys = cipher.generateKeyPair();
            const encPubKey = JSON.stringify(
                cipher.encryptStringHybrid(ownerKeys.publicKey, freshKeys.publicKey)
            );
            await sc.connect(freshVerifier).publishEncryptedVerifierPublicKey(encPubKey);

            await expect(sc.connect(owner).publishVerifierDecryptionKey(freshVerifier.address, ""))
                .to.not.emit(sc, "VerifierDecryptionKeyReady");
        });

        it("[PSC] reverts if called by non-owner", async () => {
            const {sc, sender} = await loadFixture(secondContractFixture);
            const [,,,, freshVerifier] = await ethers.getSigners();

            await expect(sc.connect(sender).publishVerifierDecryptionKey(freshVerifier.address, ""))
                .to.be.revertedWith("Not the owner");
        });
    });

    //publishIpfsCid
    describe("[PSC] publishIpfsCid", () => {

        it("[PSC] emits DataRequiredVerificationKeyGeneration", async () => {
            const {sc, sender} = await loadFixture(secondContractFixture);

            await expect(sc.connect(sender).publishIpfsCid(encryptedCid, validPosition))
                .to.emit(sc, "DataRequiredVerificationKeyGeneration")
                .withArgs(0);
        });

        it("[PSC] does NOT emit DataVerificationRequestedEvent", async () => {
            const {sc, sender} = await loadFixture(secondContractFixture);

            await expect(sc.connect(sender).publishIpfsCid(encryptedCid, validPosition))
                .to.not.emit(sc, "DataVerificationRequestedEvent");
        });

        it("[PSC] verifier cannot request auth before notifyVerificationKeyReady", async () => {
            const {sc, sender, verifier} = await loadFixture(secondContractFixture);
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);

            await expect(sc.connect(verifier).requestAuthToVerify())
                .to.be.revertedWith("No data available for verification");
        });
    });

    //notifyVerificationKeyReady
    describe("[PSC] notifyVerificationKeyReady", () => {

        it("[PSC] reverts if called by non-owner", async () => {
            const {sc, sender} = await loadFixture(secondContractFixture);
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);

            await expect(sc.connect(sender).notifyVerificationKeyReady(0))
                .to.be.revertedWith("Not the owner");
        });

        it("[PSC] reverts if dataId not awaiting key generation", async () => {
            const {sc, owner} = await loadFixture(secondContractFixture);

            await expect(sc.connect(owner).notifyVerificationKeyReady(0))
                .to.be.revertedWith("Data not awaiting key generation");
        });

        it("[PSC] reverts if called twice for the same dataId", async () => {
            const {sc, owner, sender} = await loadFixture(secondContractFixture);
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(0);

            await expect(sc.connect(owner).notifyVerificationKeyReady(0))
                .to.be.revertedWith("Data not awaiting key generation");
        });

        it("[PSC] emits DataVerificationRequestedEvent", async () => {
            const {sc, owner, sender} = await loadFixture(secondContractFixture);
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);

            await expect(sc.connect(owner).notifyVerificationKeyReady(0))
                .to.emit(sc, "DataVerificationRequestedEvent")
                .withArgs(0);
        });

        it("[PSC] after notify, verifier can be elected", async () => {
            const {sc, owner, sender, verifier} = await loadFixture(secondContractFixture);
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(0);

            await expect(sc.connect(verifier).requestAuthToVerify())
                .to.emit(sc, "VerifierElectedForData")
                .withArgs(verifier.address, 0);
        });
    });

    //requestAuthToVerify
    describe("[PSC] requestAuthToVerify", () => {

        it("[PSC] emits VerifierElectedForData and NOT VerifierElected", async () => {
            const {sc, owner, sender, verifier} = await loadFixture(secondContractFixture);
            await sc.connect(sender).publishIpfsCid(encryptedCid, validPosition);
            await sc.connect(owner).notifyVerificationKeyReady(0);

            await expect(sc.connect(verifier).requestAuthToVerify())
                .to.emit(sc, "VerifierElectedForData")
                .withArgs(verifier.address, 0)
                .and.to.not.emit(sc, "VerifierElected");
        });
    });

    //deliverVerificationBundle
    describe("[PSC] deliverVerificationBundle", () => {

        it("[PSC] reverts if called by non-owner", async () => {
            const {sc, sender, verifier} = await loadFixture(electedVerifierFixture);
            const bundle = ethers.toUtf8Bytes("bundle");

            await expect(sc.connect(sender).deliverVerificationBundle(0, verifier.address, bundle))
                .to.be.revertedWith("Not the owner");
        });

        it("[PSC] reverts if verifier is not active", async () => {
            const {sc, owner, verifier} = await loadFixture(secondContractFixture);
            const bundle = ethers.toUtf8Bytes("bundle");

            await expect(sc.connect(owner).deliverVerificationBundle(0, verifier.address, bundle))
                .to.be.revertedWith("Verifier not active");
        });

        it("[PSC] reverts if bundle already delivered", async () => {
            const {sc, owner, verifier} = await loadFixture(electedVerifierFixture);
            const bundle = ethers.toUtf8Bytes("bundle");

            await sc.connect(owner).deliverVerificationBundle(0, verifier.address, bundle);

            await expect(sc.connect(owner).deliverVerificationBundle(0, verifier.address, bundle))
                .to.be.revertedWith("Bundle already delivered");
        });

        it("[PSC] emits VerifierVerificationBundleReady with correct args", async () => {
            const {sc, owner, verifier, verifierKeys} = await loadFixture(electedVerifierFixture);

            // Enc(CID_V || KD_dec, PK_V) - hybrid perché il payload è arbitrariamente grande
            const bundlePayload = JSON.stringify({cidV: "QmXyz...", kdDec: "kd_dec_placeholder"});
            const bundleEncrypted = ethers.toUtf8Bytes(
                JSON.stringify(cipher.encryptStringHybrid(verifierKeys.publicKey, bundlePayload))
            );

            await expect(sc.connect(owner).deliverVerificationBundle(0, verifier.address, bundleEncrypted))
                .to.emit(sc, "VerifierVerificationBundleReady")
                .withArgs(verifier.address, 0, bundleEncrypted);
        });
    });

    //submitVerifyResult - bundle gate
    describe("[PSC] submitVerifyResult bundle gate", () => {

        it("[PSC] reverts if verifier submits before bundle is delivered", async () => {
            const {sc, verifier} = await loadFixture(electedVerifierFixture);

            await expect(sc.connect(verifier).submitVerifyResult(VerificationResult.SUCCESS))
                .to.be.revertedWith("Bundle not delivered yet");
        });
    });
});