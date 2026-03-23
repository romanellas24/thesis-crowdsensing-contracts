import {CipherProvider, EncryptionKeyPair, KeyPair} from "./CipherProvider";

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

    private readonly signer: any;
    private readonly contract: any;
    private readonly dstToken: any;
    private readonly keys: KeyPair;
    private readonly cipher: CipherProvider;
    private readonly encryptionKeys: EncryptionKeyPair;
    private listening = false;

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
     */
    startListening(): void {
        if (this.listening) return;
        this.listening = true;

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
        if (!this.listening) return;
        this.contract.removeAllListeners("SenderEnrolledEvent");
        this.contract.removeAllListeners("VerifierEnrolledEvent");
        this.listening = false;
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
}