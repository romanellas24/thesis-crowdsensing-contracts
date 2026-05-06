import {toUtf8Bytes} from "ethers";
import {CipherProvider, KeyPair} from "./CipherProvider";

/**
 * SDK wrapper for a data contributor (A).
 *
 * Lifecycle:
 *  1. `enroll()`                   -> key exchange with B through SC, obtains Kenc
 *  2. `payBond()`                  -> DST approval + bond deposit
 *  3. `publishData(cid, position)` -> encrypts CID with Kenc, sends to SC
 *
 * `setup()` is a convenience that calls enroll + payBond.
 */
export class SenderPrivacyFirst {

    private readonly signer: any;
    private readonly contract: any;
    private readonly dstToken: any;
    private readonly cipher: CipherProvider;
    private keys: KeyPair | null = null;
    private kenc: string | null = null;
    private _enrolled = false;

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
        cipher: CipherProvider,
    ) {
        this.signer = signer;
        this.contract = contract;
        this.dstToken = dstToken;
        this.cipher = cipher;
    }

    // Getters
    isEnrolled(): boolean {
        return this._enrolled;
    }

    getAddress(): string {
        return this.signer.address;
    }

    /**
     * Exposed for testing purposes only.
     * In production the encryption key must stay private.
     */
    getKenc(): string {
        if (!this.kenc) throw new Error("Not enrolled");
        return this.kenc;
    }

    // Enrollment

    /**
     * Perform the full key-exchange handshake:
     *  1. Generate a campaign-specific key pair
     *  2. Encrypt PKA with PKB and publish to SC
     *  3. Wait for B's response (SenderEncryptionKeyReady event)
     *  4. Decrypt received payload -> store Kenc
     *
     * Requires the Owner to be listening (auto or manual).
     */
    async enroll(): Promise<void> {
        this.keys = this.cipher.generateKeyPair();

        // Listener must be registered BEFORE the tx so we don't miss the event
        const waitForKey = new Promise<string>((resolve, reject) => {
            const handler = (sender: string, encryptionKey: string) => {
                if (sender !== this.signer.address) return;
                // Cleanup to avoid leaks
                this.contract.removeListener("SenderEncryptionKeyReady", handler);
                resolve(encryptionKey);
            };
            this.contract.on("SenderEncryptionKeyReady", handler);
        });

        const ownerPubKey: string = await this.contract
            .connect(this.signer)
            .getInitiatorPublicKey();

        const encryptedPK = this.cipher.encryptStringHybrid(ownerPubKey, this.keys.publicKey);
        await this.contract
            .connect(this.signer)
            .publishEncryptedSenderPublicKey(JSON.stringify(encryptedPK));

        const encryptedKenc = await waitForKey;
        this.kenc = this.cipher.decryptStringHybrid(
            this.keys.privateKey,
            JSON.parse(encryptedKenc),
        );
        this._enrolled = true;
    }

    // Bond
    /**
     * Approve + deposit the sender bond.
     * The required amount is read from the contract (`getRequiredSenderBond`).
     */
    async payBond(): Promise<void> {
        const required: bigint = await this.contract.getRequiredSenderBond();
        if (required === 0n) return; // maxDataPerSender == 0 -> unlimited, no bond needed

        await this.dstToken
            .connect(this.signer)
            .approve(await this.contract.getAddress(), required);
        await this.contract.connect(this.signer).senderPayBond();
    }

    /** Convenience: enroll + payBond in one call. */
    async setup(): Promise<void> {
        await this.enroll();
        await this.payBond();
    }

    // Data submission
    /**
     * Encrypt a plain-text CID with Kenc and publish to SC.
     *
     * @param plainCid   - The IPFS CID in plain text
     * @param position   - GlobalPosition struct matching the Solidity definition
     */
    async publishData(plainCid: string, position: any) {
        if (!this.kenc) throw new Error("Not enrolled - Kenc not available");

        const encrypted = this.cipher.encryptStringHybrid(this.kenc, plainCid);
        const cidBytes = toUtf8Bytes(JSON.stringify(encrypted));
        return this.contract.connect(this.signer).publishIpfsCid(cidBytes, position);
    }

    // Withdraw
    async withdrawBond() {
        return this.contract.connect(this.signer).withdrawBond();
    }
}