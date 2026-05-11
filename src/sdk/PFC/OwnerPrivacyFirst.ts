import {CipherProvider, EncryptionKeyPair, KeyPair} from "../utils/CipherProvider";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {DataSentTokenContract, PrivacyFirstContract} from "../../../typechain-types";

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
    protected readonly signer: HardhatEthersSigner;
    protected readonly contract: PrivacyFirstContract;
    protected readonly dstToken: DataSentTokenContract;
    protected readonly keys: KeyPair;
    protected readonly cipher: CipherProvider;
    protected readonly encryptionKeys: EncryptionKeyPair;
    protected _listening: boolean = false;
    protected _countValid: bigint = 0n;
    protected _countInvalid: bigint = 0n;

    constructor(
        signer: HardhatEthersSigner,
        contract: PrivacyFirstContract,
        dstToken: DataSentTokenContract,
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
            this.contract.getEvent("SenderEnrolledEvent"),
            async (sender: string, key: string) => {
                await this.handleSenderEnrollment(sender, key);
            },
        );

        this.contract.on(
            this.contract.getEvent("VerifierEnrolledEvent"),
            async (verifier: string, key: string) => {
                await this.handleVerifierEnrollment(verifier, key);
            },
        );

        this.contract.on(
            this.contract.getEvent("DataVerified"), (dataId: bigint, result: boolean) => {
                this.handleDataVerificationCompleted(dataId, result);
            }
        );
    }

    async stopListening(): Promise<void> {
        if (!this._listening) return;
        await this.contract.off("SenderEnrolledEvent");
        await this.contract.off("VerifierEnrolledEvent");
        await this.contract.off("DataVerified");
        this._listening = false;
    }

    // Manual enrollment handlers

    /**
     * Decrypt sender's PK, encrypt Kenc with it, publish to SC.
     * Called automatically when auto-listener is active.
     */
    protected async handleSenderEnrollment(senderAddress: string, encryptedPubKeyJson: string): Promise<void> {
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
    protected async handleVerifierEnrollment(verifierAddress: string, encryptedPubKeyJson: string): Promise<void> {
        const bundle = JSON.parse(encryptedPubKeyJson);
        const verifierPubKey = this.cipher.decryptStringHybrid(this.keys.privateKey, bundle);
        const encryptedKdec = JSON.stringify(
            this.cipher.encryptStringHybrid(verifierPubKey, this.encryptionKeys.decryptionKey),
        );
        await this.contract
            .connect(this.signer)
            .publishVerifierDecryptionKey(verifierAddress, encryptedKdec);
    }

    protected handleDataVerificationCompleted(dataId: bigint, result: boolean): void {
        if(result){
            this._countValid = this._countValid + 1n;
        } else {
            this._countInvalid = this._countInvalid - 1n;
        }
    }

    // Campaign management
    protected async payInitialSupply(totalDst: number): Promise<void> {
        await this.dstToken
            .connect(this.signer)
            .approve(await this.contract.getAddress(), totalDst);
        await this.contract.connect(this.signer).payInitialSupply();
    }

    protected async closeCampaign() {
        return this.contract.connect(this.signer).closeCampaign();
    }

    protected async getCampaignData(): Promise<{cids: any[]; statuses: any[]; chunks: any[]}> {
        const [cids, statuses, chunks] = await this.contract
            .connect(this.signer)
            .getCampaignData();
        return {cids, statuses, chunks};
    }

    public get listening(): boolean {
        return this._listening;
    }

}