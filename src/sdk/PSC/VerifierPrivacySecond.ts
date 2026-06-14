import {toUtf8String} from "ethers";
import {VerifierPrivacyFirst} from "../PFC";
import {PrivacySecondContract} from "../../../typechain-types";
import LoopStopReason from "../utils/LoopStopReason";

/**
 * SDK wrapper for a data verifier (V) operating on PrivacySecondContract.
 *
 * Extends VerifierPrivacyFirst with the modified flow introduced by 2.6.1
 * (trusted verifier). Key differences from the base class:
 *
 *  - enroll():            waits for VerifierEnrolled (no Kdec yet).
 *  - requestAuthToVerify: parses VerifierElectedForData (no CID in event),
 *                         then awaits the VerifierVerificationBundleReady event.
 *                         The bundle Enc({encryptedCid, kdec}, PKV) is decrypted
 *                         with SKV to recover both the CID and Kdec.
 *  - requestAndVerify():  inherited unchanged - calls the overridden
 *                         requestAuthToVerify() transparently.
 *  - getKdec():           not applicable; throws an explicit error.
 *
 * There is no global Kdec in this scheme: Kdec is received per-election,
 * inside the bundle, scoped to a single (verifier, dataId) pair.
 */
export class VerifierPrivacySecond extends VerifierPrivacyFirst<PrivacySecondContract> {

    // -----------------------------------------------------------------------
    // Enrollment override - 2.6.1
    // -----------------------------------------------------------------------

    /**
     * Key-exchange handshake for PrivacySecondContract:
     *  1. Generate campaign-specific key pair
     *  2. Encrypt PKV with PKB and publish to SC
     *  3. Wait for VerifierEnrolled (confirmation only - no Kdec delivered here)
     *
     * Kdec is NOT stored after enrollment. It arrives inside the per-election
     * bundle at verification time.
     */
    override async enroll(): Promise<void> {
        this.keys = this.cipher.generateKeyPair();
        const event = this.contract.getEvent("VerifierEnrolled");
        let cleanup = () => {
        }
        let success = false;


        const waitForEnrolled = new Promise<void>((resolve) => {
            const handler = (verifier: string) => {
                if (verifier !== this.signer.address) return;
                this.contract.removeListener(event, handler);
                cleanup();
                resolve();
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


            await waitForEnrolled;
            this._enrolled = true;
        } finally {
            if (!success)
                cleanup();
        }
        // this.kdec intentionally left null - no global Kdec in this scheme
    }

    // -----------------------------------------------------------------------
    // Verification override - 2.6.1
    // -----------------------------------------------------------------------

    /**
     * Request a verification slot, then wait for the Owner to deliver the bundle.
     *
     * Flow:
     *  1. Send requestAuthToVerify tx => SC emits VerifierElectedForData(verifier, dataId)
     *     (no CID in this event, unlike PrivacyFirst's VerifierElected)
     *  2. Owner detects the event, builds Enc({encryptedCid, kdec}, PKV), calls
     *     deliverVerificationBundle => SC emits VerifierVerificationBundleReady
     *  3. This method awaits that event, decrypts with SKV, then decrypts the CID
     *
     * slotIndex is not included in VerifierElectedForData and is returned as -1.
     * It is not used by any downstream SDK method (submitResult is stateless
     * w.r.t. slot index; the SC resolves it internally via getActiveVerification).
     */
    override async requestAuthToVerify(): Promise<{ dataId: number; decryptedCid: string; slotIndex: number }> {
        if (!this.keys) throw new Error("Not enrolled");

        const {promise: decryptPromise, cancel} = this._waitForBundleAndDecrypt();
        let success = false;

        try {
            const tx = await this.contract.connect(this.signer).requestAuthToVerify();
            const receipt = await tx.wait();

            let dataId = -1;
            for (const log of receipt!.logs) {
                try {
                    const parsed = this.contract.interface.parseLog({
                        topics: log.topics as string[],
                        data: log.data,
                    });
                    if (parsed?.name === "VerifierElectedForData") {
                        if (parsed.args[0] !== this.signer.address) continue;
                        dataId = Number(parsed.args[1]);
                        break;
                    }
                } catch { /* log di un altro contratto */
                }
            }

            if (dataId === -1) throw new Error("VerifierElected event not found in receipt");

            const decryptedCid = await decryptPromise;
            success = true;   // arrivati qui senza throw -> l'handler ha già fatto cleanup da solo
            return {dataId, decryptedCid, slotIndex: -1};
        } finally {
            if (!success) cancel();   // throw lungo il percorso -> puliamo noi
        }
    }

    /**
     * Not applicable in PrivacySecond: Kdec is not stored globally.
     * Each election delivers a fresh bundle scoped to a single (verifier, dataId).
     */
    override getKdec(): string {
        throw new Error(
            "getKdec() is not available on VerifierPrivacySecond. " +
            "Kdec is received per-election inside the verification bundle.",
        );
    }

    // -----------------------------------------------------------------------
    // Kick hook - 2.6.3
    // -----------------------------------------------------------------------

    protected override _subscribeLoopStopEvents(
        requestStop: (reason: LoopStopReason) => void,
    ): () => void {
        const event = this.contract.getEvent("VerifierKicked");
        const handler = (verifier: string) => {
            if (verifier !== this.signer.address) return;
            requestStop(LoopStopReason.Kicked);
        };
        this.contract.on(event, handler);
        return () => this.contract.removeListener(event, handler);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Wait for VerifierVerificationBundleReady for a specific dataId, then:
     *  1. Decrypt the outer envelope with SKV => bundleContent JSON
     *  2. Parse { encryptedCid (hex), kdec } from bundleContent
     *  3. Decrypt the CID with Kdec => plain CID string
     */
    private _waitForBundleAndDecrypt(): { promise: Promise<string>; cancel: () => void } {
        const event = this.contract.getEvent("VerifierVerificationBundleReady");
        let cleanup = () => {
        };

        const promise = new Promise<string>((resolve, reject) => {
            const handler = (verifier: string, _dataId: bigint, bundleHex: string) => {
                if (verifier !== this.signer.address) return;
                cleanup();
                try {
                    const envelopeJson = toUtf8String(bundleHex);
                    const bundleContent = this.cipher.decryptStringHybrid(
                        this.keys!.privateKey,
                        JSON.parse(envelopeJson),
                    );
                    const {encryptedCid, kdec} = JSON.parse(bundleContent);
                    resolve(this.cipher.decryptStringHybrid(
                        kdec,
                        JSON.parse(encryptedCid),
                    ));
                } catch (e) {
                    reject(e);
                }
            };

            cleanup = () => this.contract.removeListener(event, handler);
            this.contract.on(event, handler);
        });

        return {promise, cancel: () => cleanup()};
    }
}