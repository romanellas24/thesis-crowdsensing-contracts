import {toUtf8Bytes} from "ethers";
import {CipherProvider, KeyPair, OwnerPrivacyFirst} from "../PFC";

/**
 * SDK wrapper for the campaign initiator (B) operating on PrivacySecondContract.
 *
 * Extends OwnerPrivacyFirst with the additional responsibilities introduced by
 * §2.6.1 (trusted verifier):
 *  - During verifier enrollment: store PKV locally; do NOT send Kdec upfront.
 *  - On DataRequiredVerificationKeyGeneration: cache the encrypted CID and call
 *    notifyVerificationKeyReady so the datum enters the pending queue.
 *  - On VerifierElectedForData: build a per-(verifier, data) bundle
 *    Enc({ encryptedCid, kdec }, PKV) and deliver it via deliverVerificationBundle.
 *
 * NOTE: startListening() is fully overridden (not delegating to super) because
 * PrivacySecondContract emits VerifierEnrolled(address) instead of
 * VerifierEnrolledEvent(address, string) - different name and signature.
 */
export class OwnerPrivacySecond extends OwnerPrivacyFirst {

    /**
     * Verifier public keys collected during enrollment.
     * Keyed by checksummed verifier address.
     */
    private readonly verifierPublicKeys = new Map<string, string>();

    /**
     * On-chain encryptedCid bytes (hex) cached when DataRequiredVerificationKeyGeneration
     * fires. Decoded from the publishIpfsCid calldata of the triggering transaction.
     * Keyed by dataId.
     */
    private readonly encryptedCidCache = new Map<number, string>();

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
        ownerKeys: KeyPair,
        cipher: CipherProvider,
    ) {
        super(signer, contract, dstToken, ownerKeys, cipher);
    }

    // -----------------------------------------------------------------------
    // Listener management
    // -----------------------------------------------------------------------

    /**
     * Subscribe to all relevant contract events.
     *
     * Fully overrides the parent implementation because PrivacySecondContract
     * uses VerifierEnrolled (no key arg) instead of VerifierEnrolledEvent(address, string).
     * The SenderEnrolledEvent handler is identical to the parent's.
     */
    override startListening(): void {
        if (this._listening) return;
        this._listening = true;

        // Sender enrollment - identical to PrivacyFirst
        this.contract.on(
            "SenderEnrolledEvent",
            async (sender: string, key: string) => {
                await this.handleSenderEnrollment(sender, key);
            },
        );

        // Verifier enrollment - PrivacySecond: no key arg, store PKV locally
        this.contract.on(
            "VerifierEnrolledEvent",
            async (verifier: string, key: string) => {
                await this.handleVerifierEnrollment(verifier, key);
            },
        );

        // New in PrivacySecond: data submitted, key generation phase
        this.contract.on(
            "DataRequiredVerificationKeyGeneration",
            async (dataId: bigint, event: any) => {
                await this.handleDataRequiresKey(Number(dataId), event);
            },
        );

        // New in PrivacySecond: verifier elected, deliver bundle
        this.contract.on(
            "VerifierElectedForData",
            async (verifier: string, dataId: bigint) => {
                await this.handleVerifierElected(verifier, Number(dataId));
            },
        );
    }

    override stopListening(): void {
        if (!this._listening) return;
        this.contract.off("SenderEnrolledEvent");
        this.contract.off("VerifierEnrolledEvent");
        this.contract.off("DataRequiredVerificationKeyGeneration");
        this.contract.off("VerifierElectedForData");
        this._listening = false;
    }

    // -----------------------------------------------------------------------
    // Enrollment override - §2.6.1
    // -----------------------------------------------------------------------

    /**
     * Decrypt PKV, store it locally, confirm enrollment on SC without sending Kdec.
     *
     * The SC override ignores the decryptionKey parameter entirely; we pass an
     * empty string to satisfy the ABI while keeping intent clear.
     */
    override async handleVerifierEnrollment(
        verifierAddress: string,
        encryptedPubKeyJson: string,
    ): Promise<void> {
        const bundle = JSON.parse(encryptedPubKeyJson);
        const verifierPubKey = this.cipher.decryptStringHybrid(this.keys.privateKey, bundle);
        this.verifierPublicKeys.set(verifierAddress, verifierPubKey);

        // Empty string: the SC override (publishVerifierDecryptionKey in
        // PrivacySecondContract) ignores the second argument - it only
        // registers the verifier and emits VerifierEnrolled.
        await this.contract
            .connect(this.signer)
            .publishVerifierDecryptionKey(verifierAddress, "");
    }

    // -----------------------------------------------------------------------
    // Data key-generation phase - §2.6.1
    // -----------------------------------------------------------------------

    /**
     * Triggered by DataRequiredVerificationKeyGeneration (auto) or callable manually.
     *
     * 1. Extracts encryptedCid from the triggering transaction's calldata and
     *    caches it - avoids the need for a per-entry getter on the contract.
     * 2. Calls notifyVerificationKeyReady so the datum enters the pending queue.
     *
     * Cache ordering is safe: a verifier can only be elected after
     * notifyVerificationKeyReady succeeds, which happens here after caching.
     */
    async handleDataRequiresKey(dataId: number, event: any): Promise<void> {
        const tx = await event.log.getTransaction();
        const decoded = this.contract.interface.parseTransaction({data: tx.data});
        // publishIpfsCid(bytes encryptedCid, GlobalPosition position)
        const encryptedCid: string = decoded.args[0];
        this.encryptedCidCache.set(dataId, encryptedCid);

        await this.contract
            .connect(this.signer)
            .notifyVerificationKeyReady(dataId);
    }

    // -----------------------------------------------------------------------
    // Bundle delivery - §2.6.1
    // -----------------------------------------------------------------------

    /**
     * Triggered by VerifierElectedForData (auto) or callable manually.
     *
     * Builds a per-(verifier, data) bundle:
     *   bundle = Enc({ encryptedCid: hex, kdec: string }, PKV)
     * and delivers it on-chain via deliverVerificationBundle.
     *
     * The verifier will decrypt the bundle with SKV, recovering both the
     * on-chain encrypted CID and Kdec, then decrypt the CID locally.
     */
    async handleVerifierElected(verifier: string, dataId: number): Promise<void> {
        const pkV = this.verifierPublicKeys.get(verifier);
        if (!pkV) throw new Error(`[OwnerPrivacySecond] No cached PK for verifier ${verifier}`);

        const encryptedCid = this.encryptedCidCache.get(dataId);
        if (!encryptedCid) throw new Error(`[OwnerPrivacySecond] No cached CID for dataId ${dataId}`);

        const bundleContent = JSON.stringify({
            encryptedCid,
            kdec: this.encryptionKeys.decryptionKey,
        });

        const bundleEnvelope = this.cipher.encryptStringHybrid(pkV, bundleContent);
        const bundleBytes = toUtf8Bytes(JSON.stringify(bundleEnvelope));

        await this.contract
            .connect(this.signer)
            .deliverVerificationBundle(dataId, verifier, bundleBytes);
    }

    /**
     * PrivacySecond emits VerifierEnrolled(address) instead of
     * VerifierDecryptionKeyReady(address, string) - event name changed, key arg removed.
     */
    protected override _verifierConfirmedEvent(): string {
        return "VerifierEnrolled";
    }

    // -----------------------------------------------------------------------
    // Extra public helpers - PrivacySecond only
    // -----------------------------------------------------------------------

    /**
     * Manually kick a misbehaving verifier (owner-only on-chain function).
     */
    async kickVerifier(verifier: string): Promise<void> {
        const tx = await this.contract.connect(this.signer).kickVerifier(verifier);
        await tx.wait();
    }

    /**
     * Query the expected decayed sender reward for the next submission in a chunk.
     * Useful for UI / off-chain incentive display.
     */
    async getExpectedSenderReward(chunkIndex: number): Promise<bigint> {
        return this.contract.getExpectedSenderReward(chunkIndex);
    }
}