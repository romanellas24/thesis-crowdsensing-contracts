import {toUtf8String} from "ethers";
import {CipherProvider, KeyPair, VerificationResult, VerifyCallback} from "../utils/CipherProvider";
import LoopStopReason from "../../sdk/utils/LoopStopReason";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {DataSentTokenContract, PrivacyFirstContract} from "../../../typechain-types";

function createNotifier() {
    let pending = false;
    let resolve: (() => void) | null = null;
    return {
        notify() {
            if (resolve) {
                const r = resolve;
                resolve = null;
                r();
            } else {
                pending = true;
            }
        },
        wait(): Promise<void> {
            if (pending) {
                pending = false;
                return Promise.resolve();
            }
            return new Promise(r => {
                resolve = r;
            });
        },
    };
}


export interface VerifyLoopHandle {
    /** Gracefully stop the loop. Resolves `done` with ManualStop. */
    stop(): void;

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
export class VerifierPrivacyFirst<C extends PrivacyFirstContract = PrivacyFirstContract> {

    // protected: child classes (VerifierPrivacySecond) need direct access
    protected readonly signer: HardhatEthersSigner;
    protected readonly contract: C;
    protected readonly dstToken: DataSentTokenContract;
    protected readonly cipher: CipherProvider;
    private verifyCallback: VerifyCallback;
    protected keys: KeyPair | null = null;
    protected kdec: string | null = null;
    protected _enrolled: boolean = false;

    constructor(
        signer: HardhatEthersSigner,
        contract: C,
        dstToken: DataSentTokenContract,
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

        const event = this.contract.getEvent("VerifierDecryptionKeyReady");
        let cleanup = () => {
        };
        let success = false;


        const waitForKey = new Promise<string>((resolve) => {
            const handler = (verifier: string, decryptionKey: string) => {
                if (verifier !== this.signer.address) return;
                this.contract.removeListener(event, handler);
                cleanup();
                resolve(decryptionKey);
            };
            cleanup = () => this.contract.removeListener(event, handler);
            this.contract.on(event, handler);
        });


        try {
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
            success = true;
        } finally {
            if (!success) cleanup();
        }
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

    async fullSetup(maxItems = Infinity): Promise<VerifyLoopHandle> {
        await this.setup();
        return this.startVerifyLoop(maxItems);
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
    async requestAndVerify(): Promise<{ dataId: number; decryptedCid: string; result: VerificationResult }> {
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
    async requestAuthToVerify(): Promise<{ dataId: number; decryptedCid: string; slotIndex: number }> {
        if (!this.kdec) throw new Error("Not enrolled - Kdec not available");

        const tx = await this.contract.connect(this.signer).requestAuthToVerify();
        const receipt = await tx.wait();

        let dataId = -1;
        let slotIndex = -1;
        let encryptedCidHex = "";
        let verifier: string;

        for (const log of receipt!.logs) {
            try {
                const parsed = this.contract.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });
                if (parsed?.name === "VerifierElected") {

                    verifier = parsed.args[0];

                    if (verifier !== this.signer.address)
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
     * The loop calls requestAndVerify() repeatedly until one of the stop
     * conditions below is reached. The returned handle exposes:
     *  - stop(): request a graceful shutdown
     *  - done:   a Promise that resolves with the LoopStopReason that
     *            terminated the loop (or rejects on an unexpected error)
     *
     * Stop conditions:
     *  - Success             => completed++; if maxItems is reached the loop
     *                          exits with MaxItemsReached. Otherwise it loops
     *                          back and attempts another verification at once.
     *  - "No data available" => the loop suspends on an internal notifier until
     *                          the next DataVerificationRequestedEvent. Events
     *                          fired during a busy attempt are buffered by the
     *                          notifier and consumed on the next wait without
     *                          a round-trip delay.
     *  - Bond exhausted      => exits with BondExhausted. The caller must call
     *                          payBond() and start a new loop - the bond is not
     *                          auto-refilled here because the verifier may not
     *                          have DST available.
     *  - Campaign closed     => exits with CampaignClosed.
     *  - stop() called       => exits with ManualStop. If invoked while the loop
     *                          is suspended on the notifier, stop() signals it
     *                          so the suspension unblocks immediately.
     *  - Unexpected error    => done rejects with the original error. If the
     *                          caller is not awaiting done, the rejection
     *                          surfaces as an unhandledRejection.
     *
     * The DataVerificationRequestedEvent listener is registered before the loop
     * starts and removed in a finally block, so it is cleaned up regardless of
     * how the loop terminates.
     *
     * NOTE (PrivacySecond): requestAuthToVerify awaits bundle delivery from the
     * Owner. If the Owner is unreachable the loop stalls inside that await
     * indefinitely. A production deployment should wrap each attempt with a
     * per-verification timeout.
     *
     * @param maxItems  Max successful verifications before stopping (default: Infinity).
     * @returns         A {@link VerifyLoopHandle} with stop() and a done promise
     *                  resolving to the terminating {@link LoopStopReason}.
     */
    startVerifyLoop(maxItems = Infinity): VerifyLoopHandle {
        let completed = 0;
        let stopped = false;
        let externalStopReason: LoopStopReason | null = null;
        const notifier = createNotifier();
        const event = this.contract.getEvent("DataVerificationRequestedEvent");
        const onNewData = () => notifier.notify();

        this.contract.on(event, onNewData);

        const requestStop = (reason: LoopStopReason) => {
            if (stopped) return;
            stopped = true;
            externalStopReason = reason;
            notifier.notify();
        };

        const unsubscribeStopEvents = this._subscribeLoopStopEvents(requestStop);

        const done: Promise<LoopStopReason> = (async () => {
            try {
                while (!stopped) {
                    if (completed >= maxItems)
                        return LoopStopReason.MaxItemsReached;

                    try {
                        await this.requestAndVerify();
                        completed++;
                    } catch (e: any) {
                        if (externalStopReason !== null)
                            return externalStopReason;

                        const msg: string = e?.reason ?? e?.message ?? String(e);

                        if (msg.includes("No data available for verification")) {
                            await notifier.wait();
                            continue;
                        }
                        if (msg.includes("Insufficient DST balance in bond"))
                            return LoopStopReason.BondExhausted;
                        if (msg.includes("Campaign is closed"))
                            return LoopStopReason.CampaignClosed;

                        throw e;
                    }
                }
                if (externalStopReason !== null)
                    return externalStopReason;
                return LoopStopReason.ManualStop;
            } finally {
                stopped = true;
                await this.contract.removeListener(event, onNewData);
                unsubscribeStopEvents();
            }
        })();

        return {
            stop: () => {
                if (stopped) return;
                stopped = true;
                notifier.notify();
            },
            done
        };
    }

    /**
     * Hook for subclasses to subscribe to additional events that must terminate
     * the loop (e.g. VerifierKicked in PrivacySecond). The returned function is
     * called inside the loop's finally block to remove the listener.
     *
     * Default: no extra subscriptions.
     */
    protected _subscribeLoopStopEvents(
        _requestStop: (reason: LoopStopReason) => void,
    ): () => void {
        return () => {
        };
    }
}