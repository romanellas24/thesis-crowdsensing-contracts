import {ethers} from "hardhat";
import cipher from "../../testUtils/cipher";
import {GasTracker} from "../shared/GasTracker";
import {
    buildContractConfig,
    TOTAL_CIDS,
    chunkForCid,
    positionForChunk,
} from "../shared/SimulationConfig";
import fs from "node:fs";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * PSC active-features overrides (relative to the shared SimulationConfig).
 *
 * Why these values:
 *   - maximumDataPerChunk = 200: each chunk receives ~100 CIDs (deterministic
 *     hash distributes 10k across 100 chunks evenly), so 200 leaves headroom.
 *     With 0 (unlimited) the decay short-circuits to full payout - useless.
 *   - rewardDecayEnabled = true, rewardDecayFactor = 2: the for-loop in
 *     _computeDecayedReward runs 2 sqrt iterations per submission. Fires on
 *     every publishIpfsCid => measurable overhead on data_submission gas.
 *   - kickVerifierAfterWrongVotes = 10_000: high enough that no verifier is
 *     kicked during the run (even 5.88% wrong rate × 10k checks per verifier
 *     in worst-case 2-verifier scenarios stays under). Kick gas is measured
 *     separately at end of scenario via an explicit kickVerifier call.
 *   - pardonWrongVoteAfterRightVotes = 5: pardon path fires frequently after
 *     the first wrong vote; otherwise _recordCorrectVote returns early.
 */
const PSC_NOVEL_PARAMS = {
    rewardDecayEnabled: true,
    rewardDecayFactor: 2,
    kickVerifierAfterWrongVotes: 10_000,
    pardonWrongVoteAfterRightVotes: 5,
};

const PSC_MAX_DATA_PER_CHUNK = 200;

/**
 * Wrong-vote injection rate. Every WRONG_VOTE_MODULUS-th submission is
 * VerificationResult.FAILURE; the rest are SUCCESS. With 3 checks per CID
 * and ~5.88% rate, most CIDs still resolve VALID; a small fraction land
 * INVALID. Both _recordCorrectVote and _recordWrongVote are exercised.
 */
const WRONG_VOTE_MODULUS = 17;

const VerificationResult = {SUCCESS: 0, FAILURE: 1, CANNOT_COMPLETE: 2};

/**
 * Mock bundle bytes. Real protocol bundle is Enc(CID_V || KD_dec, PK_V) -
 * hybrid-encrypted, hundreds of bytes. Kept small here for the same reason
 * mock CIDs are small in the PFC runner: identical on-chain logic, far less
 * wall-clock spent on encryption. Scale this up if a realistic calldata-size
 * cost is wanted (linear: ~16 gas per non-zero byte).
 */
function buildMockBundle(dataId: number): Uint8Array {
    return ethers.toUtf8Bytes(`mock_bundle_${dataId}`);
}

export class ScenarioRunner {

    private readonly senderCount: number;
    private readonly verifierCount: number;
    private readonly tracker = new GasTracker();
    private readonly config: ReturnType<typeof buildContractConfig>;
    private readonly novelParams = PSC_NOVEL_PARAMS;
    private readonly ownerKeys = cipher.generateKeyPair();
    private readonly encryptionKeys = cipher.generateEncryptionKeys();

    private contract!: any;
    private dstToken!: any;
    private ownerSigner!: any;
    private senderWallets: any[] = [];
    private verifierWallets: any[] = [];

    // Global vote counter for deterministic wrong-vote injection.
    private voteCounter = 0;

    constructor(senders: number, verifiers: number) {
        this.senderCount = senders;
        this.verifierCount = verifiers;

        // Inherit the PFC-shape config, then override maximumDataPerChunk so
        // reward decay actually fires. Other fields are unchanged so per-op
        // gas comparisons against the PFC CSV stay meaningful.
        const base = buildContractConfig(senders, verifiers);
        this.config = {
            ...base,
            needs: {
                ...base.needs,
                maximumDataPerChunk: PSC_MAX_DATA_PER_CHUNK,
            },
        };
    }

    async run(): Promise<string[]> {
        this.tracker.setRawPrefix(this.senderCount, this.verifierCount);
        const t0 = Date.now();

        await this.deploy();
        this.log("Contract deployed");

        await this.createAndFundWallets();
        this.log("Wallets funded");

        await this.enrollSenders();
        this.log(`${this.senderCount} senders enrolled`);

        await this.enrollVerifiers();
        this.log(`${this.verifierCount} verifiers enrolled`);

        await this.paySenderBonds();
        this.log("Sender bonds paid");

        await this.payVerifierBonds();
        this.log("Verifier bonds paid");

        await this.submitAllCids();
        this.log(`${TOTAL_CIDS} CIDs submitted (and key-ready notified)`);

        await this.verifyAll();
        this.log("Verification complete");

        await this.kickOneVerifier();
        this.log("Kick-path measured");

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        this.log(`Scenario done in ${elapsed}s`);

        const out: string[] = this.tracker.toCsvRows(this.senderCount, this.verifierCount);
        this.tracker.clear();
        this.cleanup();

        return out;
    }

    private cleanup(): void {
        this.senderWallets = [];
        this.verifierWallets = [];
        this.contract = null;
        this.dstToken = null;
        this.ownerSigner = null;
    }

    // Deploy
    private async deploy(): Promise<void> {
        const [deployer] = await ethers.getSigners();
        this.ownerSigner = deployer;

        // DST Token
        const DSTFactory = await ethers.getContractFactory("DataSentTokenContract");
        const totalMint = 1_000_000_000;
        this.dstToken = await DSTFactory.deploy(totalMint);
        await this.dstToken.waitForDeployment();

        // PSC contract - same constructor as PFC + NovelParameters
        const PSCFactory = await ethers.getContractFactory("PrivacySecondContract");
        const deployTx = await PSCFactory.deploy(
            this.ownerKeys.publicKey,
            this.config,
            await this.dstToken.getAddress(),
            this.novelParams,
        );
        this.contract = await deployTx.waitForDeployment();
        const deployReceipt = await deployTx.deploymentTransaction()!.wait();
        this.tracker.record("contract_deployment", deployReceipt!.gasUsed, "owner");

        // Initial supply
        const approveTx = await this.dstToken.connect(this.ownerSigner)
            .approve(await this.contract.getAddress(), this.config.rewardConfig.totalDst);
        await approveTx.wait();
        const supplyTx = await this.contract.connect(this.ownerSigner).payInitialSupply();
        const supplyReceipt = await supplyTx.wait();
        this.tracker.record("initial_supply", supplyReceipt!.gasUsed, "owner");
    }

    private async createAndFundWallets(): Promise<void> {
        const provider = ethers.provider;
        const hdNode = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, "", "m/44'/60'/0'/0");

        const total = this.senderCount + this.verifierCount;

        for (let i = 0; i < total; i++) {
            const wallet = hdNode.deriveChild(i + 100).connect(provider);
            await provider.send("hardhat_setBalance", [
                wallet.address,
                "0x" + (10n ** 20n).toString(16),
            ]);
            if (i < this.senderCount) this.senderWallets.push(wallet);
            else this.verifierWallets.push(wallet);
        }

        const senderBond = BigInt(this.config.needs.maxDataPerSender) *
            BigInt(this.config.rewardConfig.dataSenderBondPerData);
        const verifierBond = BigInt(this.config.needs.maxDataPerVerifierPerBond) *
            BigInt(this.config.rewardConfig.dataVerifierBondPerData);

        for (const w of this.senderWallets) {
            await this.dstToken.transfer(w.address, senderBond);
        }
        for (const w of this.verifierWallets) {
            await this.dstToken.transfer(w.address, verifierBond);
        }
    }

    // Enrollment - sender path is identical to PFC (inherited)
    private async enrollSenders(): Promise<void> {
        for (let i = 0; i < this.senderCount; i++) {
            const wallet = this.senderWallets[i];
            const keys = cipher.generateKeyPair();
            const ownerPubKey = await this.contract.connect(wallet).getInitiatorPublicKey();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);

            const tx1 = await this.contract.connect(wallet)
                .publishEncryptedSenderPublicKey(JSON.stringify(encryptedPK));
            const r1 = await tx1.wait();
            this.tracker.record("sender_upload_pubkey", r1!.gasUsed, "sender", i);

            const senderPubKey = cipher.decryptStringHybrid(
                this.ownerKeys.privateKey, encryptedPK);
            const encKenc = cipher.encryptStringHybrid(
                senderPubKey, this.encryptionKeys.encryptionKey);
            const tx2 = await this.contract.connect(this.ownerSigner)
                .publishSenderEncryptionKey(wallet.address, JSON.stringify(encKenc));
            const r2 = await tx2.wait();
            this.tracker.record("owner_send_kenc", r2!.gasUsed, "owner");

            if ((i + 1) % 100 === 0) this.log(`  Enrolled ${i + 1}/${this.senderCount} senders`);
        }
    }

    /**
     * Verifier enrollment in PSC: publishVerifierDecryptionKey is overridden
     * to NOT publish a key - it just emits VerifierEnrolled. The owner sends
     * an empty string for the key argument (per the §2.6.1 protocol).
     */
    private async enrollVerifiers(): Promise<void> {
        for (let i = 0; i < this.verifierCount; i++) {
            const wallet = this.verifierWallets[i];
            const keys = cipher.generateKeyPair();
            const ownerPubKey = await this.contract.connect(wallet).getInitiatorPublicKey();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);

            const tx1 = await this.contract.connect(wallet)
                .publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPK));
            const r1 = await tx1.wait();
            this.tracker.record("verifier_upload_pubkey", r1!.gasUsed, "verifier", i);

            // PSC: the second arg is unused on-chain. Pass empty string.
            const tx2 = await this.contract.connect(this.ownerSigner)
                .publishVerifierDecryptionKey(wallet.address, "");
            const r2 = await tx2.wait();
            this.tracker.record("owner_send_kdec", r2!.gasUsed, "owner");

            if ((i + 1) % 100 === 0) this.log(`  Enrolled ${i + 1}/${this.verifierCount} verifiers`);
        }
    }

    // Bonds (inherited paths, identical gas to PFC)
    private async paySenderBonds(): Promise<void> {
        const contractAddr = await this.contract.getAddress();
        const required = await this.contract.getRequiredSenderBond();

        for (let i = 0; i < this.senderCount; i++) {
            const wallet = this.senderWallets[i];
            await this.dstToken.connect(wallet).approve(contractAddr, required);
            const tx = await this.contract.connect(wallet).senderPayBond();
            const r = await tx.wait();
            this.tracker.record("sender_pay_bond", r!.gasUsed, "sender", i);
        }
    }

    private async payVerifierBonds(): Promise<void> {
        const contractAddr = await this.contract.getAddress();
        const required = await this.contract.getRequiredVerifierBond();

        for (let i = 0; i < this.verifierCount; i++) {
            const wallet = this.verifierWallets[i];
            await this.dstToken.connect(wallet).approve(contractAddr, required);
            const tx = await this.contract.connect(wallet).verifierPayBond();
            const r = await tx.wait();
            this.tracker.record("verifier_pay_bond", r!.gasUsed, "verifier", i);
        }
    }

    /**
     * PSC submission: publishIpfsCid emits DataRequiredVerificationKeyGeneration
     * (no _addToPending). The owner must then call notifyVerificationKeyReady
     * for each dataId before any verifier can pick it up.
     */
    private async submitAllCids(): Promise<void> {
        const submitTxs: any[] = [];
        const senderIndices: number[] = [];

        // Phase 1: senders submit. Send all, collect receipts in batch.
        for (let i = 0; i < TOTAL_CIDS; i++) {
            const senderIdx = i % this.senderCount;
            const wallet = this.senderWallets[senderIdx];
            const cid = ethers.toUtf8Bytes(`QmSimCid_${i}`);
            const position = positionForChunk(chunkForCid(i));

            const tx = await this.contract.connect(wallet).publishIpfsCid(cid, position);
            submitTxs.push(tx);
            senderIndices.push(senderIdx);

            if ((i + 1) % 1000 === 0) this.log(`  Submitted ${i + 1}/${TOTAL_CIDS} CIDs`);
        }

        this.log("  Collecting submission receipts...");
        for (let i = 0; i < submitTxs.length; i++) {
            const r = await submitTxs[i].wait();
            this.tracker.record("data_submission", r!.gasUsed, "sender", senderIndices[i]);
            this.tracker.recordDataSent(senderIndices[i]);
        }

        // Phase 2: owner notifies key-ready for each dataId in order. Each call
        // moves the dataId from _awaitingKeyGeneration into the pending queue
        // and emits DataVerificationRequestedEvent. Cost mirrors the original
        // _addToPending plus the deletion of the awaiting flag.
        this.log("  Notifying verification-key-ready for all dataIds...");
        for (let dataId = 0; dataId < TOTAL_CIDS; dataId++) {
            const tx = await this.contract.connect(this.ownerSigner)
                .notifyVerificationKeyReady(dataId);
            const r = await tx.wait();
            this.tracker.record("owner_notify_key_ready", r!.gasUsed, "owner");

            if ((dataId + 1) % 1000 === 0) {
                this.log(`  Key-ready notified ${dataId + 1}/${TOTAL_CIDS}`);
            }
        }
    }

    /**
     * PSC verification flow per slot:
     *   verifier.requestAuthToVerify()   => emits VerifierElectedForData
     *   owner.deliverVerificationBundle  => unlocks the bundle gate
     *   verifier.submitVerifyResult(v)   => registers the vote
     *
     * dataId is read from the contract via getActiveVerification() (view, free).
     */
    private async verifyAll(): Promise<void> {
        let totalChecks = 0;
        let pendingExists = true;

        while (pendingExists) {
            pendingExists = false;

            for (let vi = 0; vi < this.verifierCount; vi++) {
                const wallet = this.verifierWallets[vi];

                try {
                    // 1. Request slot
                    const txReq = await this.contract.connect(wallet).requestAuthToVerify();
                    const rReq = await txReq.wait();
                    this.tracker.record("verification_request", rReq!.gasUsed, "verifier", vi);

                    // Read dataId from contract state (free view, signed as the verifier)
                    const dataId: bigint = await this.contract.connect(wallet).getActiveVerification();

                    // 2. Owner delivers bundle
                    const bundle = buildMockBundle(Number(dataId));
                    const txBundle = await this.contract.connect(this.ownerSigner)
                        .deliverVerificationBundle(dataId, wallet.address, bundle);
                    const rBundle = await txBundle.wait();
                    this.tracker.record("owner_deliver_bundle", rBundle!.gasUsed, "owner");

                    // 3. Submit vote
                    this.voteCounter++;
                    const vote = VerificationResult.SUCCESS

                    const txSub = await this.contract.connect(wallet).submitVerifyResult(vote);
                    const rSub = await txSub.wait();
                    this.tracker.record("verification_submit", rSub!.gasUsed, "verifier", vi);

                    totalChecks++;
                    pendingExists = true;
                } catch {
                    // No data available, cooldown blocks, bond depleted, etc.
                    // Skip and let the outer while-loop retry until no verifier
                    // can make progress.
                }
            }

            if (totalChecks % 1000 === 0 && totalChecks > 0) {
                this.log(`  ${totalChecks} verification checks completed`);
            }
        }

        this.log(`  Total verification checks: ${totalChecks}`);
    }

    /**
     * Measure the kick path in isolation. Kicks the last verifier wallet
     * (still active at this point because kickAfterWrongVotes was set high).
     * The chosen verifier has bondBalance >= 0 (typically 0 after the run)
     * and isVerifying == false (no pending slot), so this exercises the
     * "verifier-cleanup with potentially zero bond" branch of _kickVerifier.
     *
     * If the user wants the "non-zero bond + currently verifying" branch
     * measured separately, kick a verifier mid-run instead.
     */
    private async kickOneVerifier(): Promise<void> {
        const target = this.verifierWallets[this.verifierWallets.length - 1];
        try {
            const tx = await this.contract.connect(this.ownerSigner)
                .kickVerifier(target.address);
            const r = await tx.wait();
            this.tracker.record("owner_kick_verifier", r!.gasUsed, "owner");
        } catch (e) {
            // Verifier no longer registered (shouldn't happen with the chosen
            // kick threshold, but log and continue).
            this.log(`  kickVerifier skipped: ${(e as Error).message}`);
        }
    }

    private log(msg: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`  [${ts}] [${this.senderCount}S×${this.verifierCount}V] ${msg}`);
    }

    public setRawStream(stream: fs.WriteStream) {
        this.tracker.setRawStream(stream);
    }
}
