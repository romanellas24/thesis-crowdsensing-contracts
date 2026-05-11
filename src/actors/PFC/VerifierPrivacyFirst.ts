import {toUtf8String} from "ethers";
import {CipherProvider, KeyPair, VerificationResult, VerifyCallback} from "../../sdk/utils/CipherProvider";
import LoopStopReason from "../../sdk/utils/LoopStopReason";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";

// ---------------------------------------------------------------------------
// Loop types - exported so callers can discriminate the stop reason
// ---------------------------------------------------------------------------

export interface VerifyLoopHandle {
    /** Gracefully stop the loop. Resolves `done` with ManualStop. */
    stop(): void;
    /** Resolves with the reason the loop ended. Never rejects. */
    done: Promise<LoopStopReason>;
}

/**
 * SDK wrapper for a data verifier (V).
 *
 * Lifecycle:
 *  1. `enroll()`   -> key exchange with B through SC, obtains Kdec
 *  2. `payBond()`  -> DST approval + bond deposit
 *  3. `requestAndVerify()` -> request slot, decrypt CID, invoke callback, submit result
 *
 * The callback is sync: `(decryptedCid, dataId) => VerificationResult`.
 * For finer control use `requestAuthToVerify()` + `submitResult()` separately.
 */
export class VerifierPrivacyFirst {

    // protected: child classes (VerifierPrivacySecond) need direct access
    protected readonly signer: HardhatEthersSigner;
    protected readonly contract: any;
    protected readonly dstToken: any;
    protected readonly cipher: CipherProvider;
    private verifyCallback: VerifyCallback;
    protected keys: KeyPair | null = null;
    protected kdec: string | null = null;
    protected _enrolled = false;

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
        cipher: CipherProvider,
        verifyCallback: VerifyCallback,
    ) {
        this.signer = signer;
        this.contract = contract;
        this.dstToken = dstToken;
        this.cipher = cipher;
        this.verifyCallback = verifyCallback;
    }

    // Getters

    isEnrolled(): boolean {
        return this._enrolled;
    }

    getAddress(): string {
        return this.signer.address;
    }

    setVerifyCallback(cb: VerifyCallback): void {
        this.verifyCallback = cb;
    }

    /**
     * Exposed for testing purposes only.
     */
    getKdec(): string {
        if (!this.kdec) throw new Error("Not enrolled");
        return this.kdec;
    }

    // Enrollment

    /**
     * Full key-exchange handshake:
     *  1. Generate campaign-specific key pair
     *  2. Encrypt PKV with PKB and publish to SC
     *  3. Wait for B's response (VerifierDecryptionKeyReady event)
     *  4. Decrypt received payload -> store Kdec
     */
    async enroll(): Promise<void> {
        this.keys = this.cipher.generateKeyPair();

        const waitForKey = new Promise<string>((resolve) => {
            const handler = (verifier: string, decryptionKey: string) => {
                if (verifier !== this.signer.address) return;
                this.contract.removeListener("VerifierDecryptionKeyReady", handler);
                resolve(decryptionKey);
            };
            this.contract.on("VerifierDecryptionKeyReady", handler);
        });

        const ownerPubKey: string = await this.contract
            .connect(this.signer)
            .getInitiatorPublicKey();

        const encryptedPK = this.cipher.encryptStringHybrid(ownerPubKey, this.keys.publicKey);
        await this.contract
            .connect(this.signer)
            .publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPK));

        const encryptedKdec = await waitForKey;
        this.kdec = this.cipher.decryptStringHybrid(
            this.keys.privateKey,
            JSON.parse(encryptedKdec),
        );
        this._enrolled = true;
    }

    // Bond

    async payBond(): Promise<void> {
        const required: bigint = await this.contract.getRequiredVerifierBond();
        if (required === 0n) return;

        await this.dstToken
            .connect(this.signer)
            .approve(await this.contract.getAddress(), required);
        await this.contract.connect(this.signer).verifierPayBond();
    }

    /** Convenience: enroll + payBond. */
    async setup(): Promise<void> {
        await this.enroll();
        await this.payBond();
    }

    // Verification - high-level (callback-driven)

    /**
     * One-shot: request a slot -> decrypt CID -> call callback -> submit result.
     *
     * Returns the data id, the decrypted CID, and the result the callback chose.
     */
    async requestAndVerify(): Promise<{dataId: number; decryptedCid: string; result: VerificationResult}> {
        const {dataId, decryptedCid} = await this.requestAuthToVerify();
        const result = this.verifyCallback(decryptedCid, dataId);
        const tx = await this.submitResult(result);
        await tx.wait();
        return {dataId, decryptedCid, result};
    }

    // Verification - low-level (manual control)

    /**
     * Request a verification slot. Parses the `VerifierElected` event from the
     * same transaction receipt to extract the encrypted CID, then decrypts it.
     */
    async requestAuthToVerify(): Promise<{dataId: number; decryptedCid: string; slotIndex: number}> {
        if (!this.kdec) throw new Error("Not enrolled - Kdec not available");

        const tx = await this.contract.connect(this.signer).requestAuthToVerify();
        const receipt = await tx.wait();

        let dataId = -1;
        let slotIndex = -1;
        let encryptedCidHex = "";
        let verifier: string;

        for (const log of receipt.logs) {
            try {
                const parsed = this.contract.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });
                if (parsed?.name === "VerifierElected") {

                    verifier = parsed.args[0];

                    if(verifier !== this.signer.address)
                        continue;

                    dataId = Number(parsed.args[1]);
                    slotIndex = Number(parsed.args[2]);
                    encryptedCidHex = parsed.args[3];
                    break;
                }
            } catch {
                // log belongs to a different contract / event - skip
            }
        }

        if (dataId === -1) throw new Error("VerifierElected event not found in receipt");

        const encryptedCidJson = toUtf8String(encryptedCidHex);
        const decryptedCid = this.cipher.decryptStringHybrid(
            this.kdec,
            JSON.parse(encryptedCidJson),
        );

        return {dataId, decryptedCid, slotIndex};
    }

    async submitResult(result: VerificationResult) {
        return this.contract.connect(this.signer).submitVerifyResult(result);
    }

    // Withdraw
    async withdrawBond() {
        return this.contract.connect(this.signer).withdrawBond();
    }

    // -----------------------------------------------------------------------
    // Continuous verification loop
    // -----------------------------------------------------------------------

    /**
     * Start a self-driven verification loop.
     *
     * The loop calls requestAndVerify() repeatedly, managing the following cases:
     *
     *  • Success            → completed++; if maxItems reached, stop with MaxItemsReached.
     *                         Otherwise retry immediately (more data may be pending).
     *  • "No data available"→ go idle; resume on the next DataVerificationRequestedEvent.
     *                         If an event arrived while we were busy, we catch it via
     *                         pendingAttempt and retry without waiting for another event.
     *  • Bond exhausted     → stop with BondExhausted. The caller must call payBond()
     *                         and start a new loop - the bond is not auto-refilled here
     *                         because the verifier may not have DST available.
     *  • Campaign closed    → stop with CampaignClosed.
     *  • Kicked (§2.6.3)    → stop with Kicked. Handled via _subscribeKickEvents hook,
     *                         overridden in VerifierPrivacySecond.
     *  • stop() called      → stop with ManualStop. If called mid-await, the check
     *                         after the await ensures the loop exits cleanly.
     *  • Unexpected error   → stop with ManualStop, then rethrow to unhandledRejection.
     *
     * NOTE (PrivacySecond): requestAuthToVerify awaits bundle delivery from the Owner.
     * If the Owner is unreachable the loop stalls inside that await indefinitely.
     * A production deployment should wrap with a per-verification timeout.
     *
     * @param maxItems  Max successful verifications before stopping (default: Infinity).
     */
    startVerifyLoop(maxItems = Infinity): VerifyLoopHandle {
        let stopped       = false;
        let isAttempting  = false;
        let pendingAttempt = false;     // DataVerificationRequestedEvent arrived while busy

        let resolveLoop!: (reason: LoopStopReason) => void;
        const done = new Promise<LoopStopReason>((res) => { resolveLoop = res; });
        let completed = 0;

        // ------------------------------------------------------------------
        // cleanup: idempotent teardown - called from every exit path
        // ------------------------------------------------------------------
        let unsubscribeKick: () => void = () => {};

        const cleanup = (reason: LoopStopReason) => {
            if (stopped) return;
            stopped = true;
            this.contract.removeListener("DataVerificationRequestedEvent", onNewData);
            unsubscribeKick();
            resolveLoop(reason);
        };

        // ------------------------------------------------------------------
        // onNewData: fired when a datum enters the pending queue
        // ------------------------------------------------------------------
        const onNewData = () => {
            if (stopped) return;
            if (isAttempting) {
                // We are mid-verification; flag so runAttempt retries after it finishes
                pendingAttempt = true;
                return;
            }
            runAttempt();
        };

        // ------------------------------------------------------------------
        // runAttempt: one full requestAndVerify cycle
        // ------------------------------------------------------------------
        const runAttempt = async () => {
            if (stopped) return;
            isAttempting  = true;
            pendingAttempt = false;

            try {
                await this.requestAndVerify();

                isAttempting = false;
                if (stopped) return;

                completed++;
                if (completed >= maxItems) {
                    cleanup(LoopStopReason.MaxItemsReached);
                    return;
                }
                // More data may already be pending - try immediately
                runAttempt();

            } catch (e: any) {
                isAttempting = false;
                if (stopped) return;

                const msg: string = e?.reason ?? e?.message ?? String(e);

                if (msg.includes("No data available for verification")) {
                    // Normal idle state - resume when next DataVerificationRequestedEvent fires.
                    // If one arrived while we were awaiting, retry right away.
                    if (pendingAttempt) runAttempt();
                    return;
                }

                if (msg.includes("Insufficient DST balance in bond")) {
                    // Bond is depleted. Caller must payBond() and start a new loop.
                    cleanup(LoopStopReason.BondExhausted);
                    return;
                }

                if (msg.includes("Campaign is closed")) {
                    cleanup(LoopStopReason.CampaignClosed);
                    return;
                }

                // Unexpected error: stop and propagate
                cleanup(LoopStopReason.ManualStop);
                throw e;
            }
        };

        // ------------------------------------------------------------------
        // Wire up listeners and kick off
        // ------------------------------------------------------------------
        this.contract.on("DataVerificationRequestedEvent", onNewData);
        unsubscribeKick = this._subscribeKickEvents(() => cleanup(LoopStopReason.Kicked));

        const stop = () => cleanup(LoopStopReason.ManualStop);

        // Start immediately - data might already be pending
        runAttempt();

        return {stop, done};
    }

    /**
     * Subscribe to the verifier-kick event for the current signer.
     * No-op in PrivacyFirst (event does not exist).
     * Overridden in VerifierPrivacySecond to listen to VerifierKicked.
     *
     * @returns Cleanup function that removes the listener.
     */
    protected _subscribeKickEvents(_onKick: () => void): () => void {
        return () => {};
    }
}