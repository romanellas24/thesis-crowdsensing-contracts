import {toUtf8Bytes} from "ethers";
import {CipherProvider, KeyPair, OwnerPrivacyFirst} from "../PFC";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {DataSentTokenContract, PrivacySecondContract} from "../../../typechain-types";

/**
 * SDK wrapper for the campaign initiator (B) operating on PrivacySecondContract.
 *
 * Extends OwnerPrivacyFirst with the additional responsibilities introduced
 * by 2.6.1 (trusted verifier):
 *  - During verifier enrollment: decrypt PKV from the inherited
 *    VerifierEnrolledEvent and cache it locally; do NOT forward Kdec to the
 *    SC. Kdec is delivered later, per-data, inside the verification bundle.
 *  - On DataRequiredVerificationKeyGeneration: cache the encrypted CID and
 *    call notifyVerificationKeyReady so the datum enters the pending queue.
 *  - On VerifierElectedForData: build a per-(verifier, data) bundle
 *    Enc({ encryptedCid, kdec }, PKV) and deliver it on-chain via
 *    deliverVerificationBundle.
 *
 * NOTE: startListening() is fully overridden (rather than delegating to
 * super) only to subscribe to the two new events introduced by PSC -
 * DataRequiredVerificationKeyGeneration and VerifierElectedForData. The
 * SenderEnrolledEvent and VerifierEnrolledEvent subscriptions are identical
 * to the parent's: the change in the verifier-enrollment flow is realized
 * via the overridden handleVerifierEnrollment, not via a different event.
 * The newly introduced VerifierEnrolled(address) event - emitted by the
 * overridden publishVerifierDecryptionKey - is not consumed by the Owner;
 * it is a signal for the verifier-side SDK.
 */
export class OwnerPrivacySecond extends OwnerPrivacyFirst<PrivacySecondContract> {

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


    /**
     * Bundle deliveries served per dataId. Used to decide when the corresponding
     * entry in encryptedCidCache can be released.
     */
    private readonly bundleDeliveryCount = new Map<number, number>();

    private assignedChecksCache: number | null = null;


    constructor(
        signer: HardhatEthersSigner,
        contract: PrivacySecondContract,
        dstToken: DataSentTokenContract,
        ownerKeys: KeyPair,
        cipher: CipherProvider,
    ) {
        super(signer, contract, dstToken, ownerKeys, cipher);
    }


    async setup(): Promise<void> {
        await super.setup();
        this.verifierPublicKeys.clear();
        this.bundleDeliveryCount.clear();
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
            this.contract.getEvent("SenderEnrolledEvent"),
            async (sender: string, key: string) => {
                await this.handleSenderEnrollment(sender, key);
            },
        );

        // Verifier enrollment - inherited from PrivacyFirst.
        // VerifierEnrolledEvent(address, string) is still emitted by the inherited
        // publishEncryptedVerifierPublicKey, carrying the verifier's encrypted PK.
        // The PSC-specific behaviour lives entirely in the overridden
        // handleVerifierEnrollment (decrypt PKV, cache locally, no Kdec emission).
        this.contract.on(
            this.contract.getEvent("VerifierEnrolledEvent"),
            async (verifier: string, key: string) => {
                await this.handleVerifierEnrollment(verifier, key);
            },
        );

        // New in PrivacySecond: data submitted, key generation phase
        this.contract.on(
            this.contract.getEvent("DataRequiredVerificationKeyGeneration"),
            async (dataId: bigint, event: any) => {
                await this.handleDataRequiresKey(Number(dataId), event);
            },
        );

        // New in PrivacySecond: verifier elected, deliver bundle
        this.contract.on(
            this.contract.getEvent("VerifierElectedForData"),
            async (verifier: string, dataId: bigint) => {
                await this.handleVerifierElected(verifier, Number(dataId));
            },
        );
    }

    async stopListening(): Promise<void> {
        if (!this._listening) return;
        await this.contract.off(this.contract.getEvent("SenderEnrolledEvent"));
        await this.contract.off(this.contract.getEvent("VerifierEnrolledEvent"));
        await this.contract.off(this.contract.getEvent("DataRequiredVerificationKeyGeneration"));
        await this.contract.off(this.contract.getEvent("VerifierElectedForData"));
        this._listening = false;
    }

    // -----------------------------------------------------------------------
    // Enrollment override - 2.6.1
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
    // Data key-generation phase - 2.6.1
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
        const encryptedCid: string = decoded!.args[0];
        this.encryptedCidCache.set(dataId, encryptedCid);

        await this.contract
            .connect(this.signer)
            .notifyVerificationKeyReady(dataId);
    }

    // -----------------------------------------------------------------------
    // Bundle delivery - 2.6.1
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


        const assigned = await this.getAssignedChecks();
        const served = (this.bundleDeliveryCount.get(dataId) ?? 0) + 1;
        if (served >= assigned) {
            this.bundleDeliveryCount.delete(dataId);
            this.encryptedCidCache.delete(dataId);
        } else {
            this.bundleDeliveryCount.set(dataId, served);
        }

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

    private async getAssignedChecks(): Promise<number> {
        if (this.assignedChecksCache !== null) return this.assignedChecksCache;
        const cfg = await this.contract.getConfig();
        this.assignedChecksCache = Number(cfg.needs.checksRequired);
        return this.assignedChecksCache;
    }

}