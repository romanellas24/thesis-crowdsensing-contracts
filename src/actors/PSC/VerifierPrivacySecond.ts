import {toUtf8String} from "ethers";
import {CipherProvider, VerifierPrivacyFirst, KeyPair, VerificationResult, VerifyCallback} from "../PFC";
/**
 * SDK wrapper for a data verifier (V) operating on PrivacySecondContract.
 *
 * Extends VerifierPrivacyFirst with the modified flow introduced by §2.6.1
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
export class VerifierPrivacySecond extends VerifierPrivacyFirst {

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
        cipher: CipherProvider,
        verifyCallback: VerifyCallback,
    ) {
        super(signer, contract, dstToken, cipher, verifyCallback);
    }

    // -----------------------------------------------------------------------
    // Enrollment override - §2.6.1
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

        const waitForEnrolled = new Promise<void>((resolve) => {
            const handler = (verifier: string) => {
                if (verifier !== this.signer.address) return;
                this.contract.removeListener("VerifierEnrolled", handler);
                resolve();
            };
            this.contract.on("VerifierEnrolled", handler);
        });

        const ownerPubKey: string = await this.contract
            .connect(this.signer)
            .getInitiatorPublicKey();

        const encryptedPK = this.cipher.encryptStringHybrid(ownerPubKey, this.keys.publicKey);
        await this.contract
            .connect(this.signer)
            .publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPK));

        await waitForEnrolled;
        this._enrolled = true;
        // this.kdec intentionally left null - no global Kdec in this scheme
    }

    // -----------------------------------------------------------------------
    // Verification override - §2.6.1
    // -----------------------------------------------------------------------

    /**
     * Request a verification slot, then wait for the Owner to deliver the bundle.
     *
     * Flow:
     *  1. Send requestAuthToVerify tx → SC emits VerifierElectedForData(verifier, dataId)
     *     (no CID in this event, unlike PrivacyFirst's VerifierElected)
     *  2. Owner detects the event, builds Enc({encryptedCid, kdec}, PKV), calls
     *     deliverVerificationBundle → SC emits VerifierVerificationBundleReady
     *  3. This method awaits that event, decrypts with SKV, then decrypts the CID
     *
     * slotIndex is not included in VerifierElectedForData and is returned as -1.
     * It is not used by any downstream SDK method (submitResult is stateless
     * w.r.t. slot index; the SC resolves it internally via getActiveVerification).
     */
    override async requestAuthToVerify(): Promise<{dataId: number; decryptedCid: string; slotIndex: number}> {
        if (!this.keys) throw new Error("Not enrolled");

        const tx = await this.contract.connect(this.signer).requestAuthToVerify();
        const receipt = await tx.wait();

        let dataId = -1;
        for (const log of receipt.logs) {
            try {
                const parsed = this.contract.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });
                if (parsed?.name === "VerifierElectedForData") {
                    dataId = Number(parsed.args[1]);
                    break;
                }
            } catch {
                // log belongs to a different contract / event - skip
            }
        }

        if (dataId === -1) throw new Error("VerifierElectedForData event not found in receipt");

        const decryptedCid = await this._waitForBundleAndDecrypt(dataId);
        return {dataId, decryptedCid, slotIndex: -1};
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
    // Kick hook - §2.6.3
    // -----------------------------------------------------------------------

    /**
     * Subscribe to VerifierKicked for the current signer.
     * Used by startVerifyLoop (inherited) to stop the loop when B kicks this verifier.
     *
     * Returns a cleanup function that removes the listener - the loop calls it on exit.
     */
    protected override _subscribeKickEvents(onKick: () => void): () => void {
        const handler = (verifier: string) => {
            if (verifier !== this.signer.address) return;
            onKick();
        };
        this.contract.on("VerifierKicked", handler);
        return () => this.contract.removeListener("VerifierKicked", handler);
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Wait for VerifierVerificationBundleReady for a specific dataId, then:
     *  1. Decrypt the outer envelope with SKV → bundleContent JSON
     *  2. Parse { encryptedCid (hex), kdec } from bundleContent
     *  3. Decrypt the CID with Kdec → plain CID string
     */
    private _waitForBundleAndDecrypt(dataId: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const handler = (verifier: string, bundleDataId: bigint, bundleHex: string) => {
                if (verifier !== this.signer.address) return;
                if (Number(bundleDataId) !== dataId) return;

                this.contract.removeListener("VerifierVerificationBundleReady", handler);

                try {
                    // Outer envelope: HybridCiphertext JSON encoded as UTF-8 bytes
                    const envelopeJson = toUtf8String(bundleHex);
                    const bundleContent = this.cipher.decryptStringHybrid(
                        this.keys!.privateKey,
                        JSON.parse(envelopeJson),
                    );

                    // Inner payload: { encryptedCid: hex, kdec: string }
                    const {encryptedCid, kdec} = JSON.parse(bundleContent);

                    // encryptedCid is the raw bytes from publishIpfsCid calldata,
                    // which itself is toUtf8Bytes(JSON.stringify(HybridCiphertext))
                    const decryptedCid = this.cipher.decryptStringHybrid(
                        kdec,
                        JSON.parse(toUtf8String(encryptedCid)),
                    );

                    resolve(decryptedCid);
                } catch (e) {
                    reject(e);
                }
            };

            this.contract.on("VerifierVerificationBundleReady", handler);
        });
    }
}