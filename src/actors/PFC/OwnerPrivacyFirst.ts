import {CipherProvider, EncryptionKeyPair, KeyPair} from "../../sdk/utils/CipherProvider";

/**
 * SDK wrapper for the campaign initiator (B).
 *
 * Responsibilities:
 *  - Generate Kenc / Kdec for IPFS data encryption
 *  - Respond to sender / verifier enrollment events
 *  - Campaign management (payInitialSupply, closeCampaign, getCampaignData)
 *
 * Two modes for enrollment handling:
 *  1. Auto-listener   -> call `startListening()`, events are handled transparently
 *  2. Manual fallback -> call `handleSenderEnrollment` / `handleVerifierEnrollment` directly
 */
export class OwnerPrivacyFirst {

    // protected: child classes (OwnerPrivacySecond) need direct access
    protected readonly signer: any;
    protected readonly contract: any;
    protected readonly dstToken: any;
    protected readonly keys: KeyPair;
    protected readonly cipher: CipherProvider;
    protected readonly encryptionKeys: EncryptionKeyPair;
    protected _listening = false;

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
        ownerKeys: KeyPair,
        cipher: CipherProvider,
    ) {
        this.signer = signer;
        this.contract = contract;
        this.dstToken = dstToken;
        this.keys = ownerKeys;
        this.cipher = cipher;
        this.encryptionKeys = cipher.generateEncryptionKeys();
    }

    // Getters

    getEncryptionKeys(): EncryptionKeyPair {
        return this.encryptionKeys;
    }

    getAddress(): string {
        return this.signer.address;
    }

    // Auto-listener mode

    /**
     * Subscribe to SenderEnrolledEvent and VerifierEnrolledEvent.
     * Enrollment responses are sent automatically.
     *
     * NOTE: OwnerPrivacySecond fully overrides this method because
     * PrivacySecondContract emits a different event for verifier enrollment
     * (VerifierEnrolled vs VerifierEnrolledEvent) with a different signature.
     */
    startListening(): void {
        if (this._listening) return;
        this._listening = true;

        this.contract.on(
            "SenderEnrolledEvent",
            async (sender: string, key: string) => {
                await this.handleSenderEnrollment(sender, key);
            },
        );

        this.contract.on(
            "VerifierEnrolledEvent",
            async (verifier: string, key: string) => {
                await this.handleVerifierEnrollment(verifier, key);
            },
        );
    }

    stopListening(): void {
        if (!this._listening) return;
        this.contract.off("SenderEnrolledEvent");
        this.contract.off("VerifierEnrolledEvent");
        this._listening = false;
    }

    // Manual enrollment handlers

    /**
     * Decrypt sender's PK, encrypt Kenc with it, publish to SC.
     * Called automatically when auto-listener is active.
     */
    async handleSenderEnrollment(senderAddress: string, encryptedPubKeyJson: string): Promise<void> {
        const bundle = JSON.parse(encryptedPubKeyJson);
        const senderPubKey = this.cipher.decryptStringHybrid(this.keys.privateKey, bundle);
        const encryptedKenc = JSON.stringify(
            this.cipher.encryptStringHybrid(senderPubKey, this.encryptionKeys.encryptionKey),
        );
        await this.contract
            .connect(this.signer)
            .publishSenderEncryptionKey(senderAddress, encryptedKenc);
    }

    /**
     * Decrypt verifier's PK, encrypt Kdec with it, publish to SC.
     * Called automatically when auto-listener is active.
     */
    async handleVerifierEnrollment(verifierAddress: string, encryptedPubKeyJson: string): Promise<void> {
        const bundle = JSON.parse(encryptedPubKeyJson);
        const verifierPubKey = this.cipher.decryptStringHybrid(this.keys.privateKey, bundle);
        const encryptedKdec = JSON.stringify(
            this.cipher.encryptStringHybrid(verifierPubKey, this.encryptionKeys.decryptionKey),
        );
        await this.contract
            .connect(this.signer)
            .publishVerifierDecryptionKey(verifierAddress, encryptedKdec);
    }

    // Campaign management
    async payInitialSupply(totalDst: number): Promise<void> {
        await this.dstToken
            .connect(this.signer)
            .approve(await this.contract.getAddress(), totalDst);
        await this.contract.connect(this.signer).payInitialSupply();
    }

    async closeCampaign() {
        return this.contract.connect(this.signer).closeCampaign();
    }

    async getCampaignData(): Promise<{cids: any[]; statuses: any[]; chunks: any[]}> {
        const [cids, statuses, chunks] = await this.contract
            .connect(this.signer)
            .getCampaignData();
        return {cids, statuses, chunks};
    }

    get listening(): boolean {
        return this._listening;
    }

    // -----------------------------------------------------------------------
    // Test / orchestration helpers
    // -----------------------------------------------------------------------

    /**
     * Resolves when at least `senderCount` senders and `verifierCount` verifiers
     * have completed enrollment - i.e., B has published their respective keys and
     * the SC has emitted the corresponding confirmation events.
     *
     * Listens to SenderEncryptionKeyReady and the verifier confirmation event
     * returned by _verifierConfirmedEvent() (overridable for PrivacySecond).
     *
     * Safe to call alongside startListening(): these listeners are independent
     * and scoped to this promise - they are removed as soon as counts are met.
     */
    waitForEnrollments(senderCount: number, verifierCount: number): Promise<void> {
        if (senderCount === 0 && verifierCount === 0) return Promise.resolve();

        return new Promise<void>((resolve) => {
            let s = 0;
            let v = 0;

            const cleanup = () => {
                if (senderCount > 0)   this.contract.removeListener("SenderEncryptionKeyReady", sHandler);
                if (verifierCount > 0) this.contract.removeListener(this._verifierConfirmedEvent(), vHandler);
            };

            const check = () => {
                if (s >= senderCount && v >= verifierCount) {
                    cleanup();
                    resolve();
                }
            };

            // Arrow functions: each call increments the respective counter then checks.
            // Using named references so removeListener can target them precisely.
            const sHandler = () => { s++; check(); };
            const vHandler = () => { v++; check(); };

            if (senderCount > 0)   this.contract.on("SenderEncryptionKeyReady", sHandler);
            if (verifierCount > 0) this.contract.on(this._verifierConfirmedEvent(), vHandler);
        });
    }

    /**
     * Name of the on-chain event that confirms verifier enrollment is complete.
     * PrivacyFirst: VerifierDecryptionKeyReady (carries the encrypted Kdec).
     * PrivacySecond: overridden to return "VerifierEnrolled" (no key arg).
     */
    protected _verifierConfirmedEvent(): string {
        return "VerifierDecryptionKeyReady";
    }

}