import {toUtf8Bytes} from "ethers";
import {CipherProvider, KeyPair} from "../utils/CipherProvider";
import {HardhatEthersSigner} from "@nomicfoundation/hardhat-ethers/signers";
import {DataSentTokenContract, PrivacyFirstContract} from "../../../typechain-types";
import cipher from "../../../testUtils/cipher";
import {success} from "hardhat/internal/core/config/config-validation";

/**
 * SDK wrapper for a data contributor (S).
 *
 * Lifecycle:
 *  1. `enroll()`                   -> key exchange with B through SC, obtains Kenc
 *  2. `payBond()`                  -> DST approval + bond deposit
 *  3. `publishData(cid, position)` -> encrypts CID with Kenc, sends to SC
 *
 * `setup()` is a convenience that calls enroll + payBond.
 */
export class SenderPrivacyFirst<C extends PrivacyFirstContract = PrivacyFirstContract> {

    private readonly signer: HardhatEthersSigner;
    private readonly contract: C;
    private readonly dstToken: DataSentTokenContract;
    private readonly _cipher: CipherProvider;
    private keys: KeyPair;
    private kenc: string | null = null;
    private _enrolled: boolean = false;

    constructor(
        signer: HardhatEthersSigner,
        contract: C,
        dstToken: DataSentTokenContract,
        cipher: CipherProvider,
    ) {
        this.signer = signer;
        this.contract = contract;
        this.dstToken = dstToken;
        this._cipher = cipher;
        this.keys = this._cipher.generateKeyPair();
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
        let success = false;
        let cleanup = () => {};

        try {
            const event = this.contract.getEvent("SenderEncryptionKeyReady");
            const waitForKey = new Promise<string>((resolve, reject) => {
                const handler = (sender: string, encryptionKey: string) => {
                    if (sender !== this.signer.address) return;
                    cleanup();
                    resolve(encryptionKey);
                };
                cleanup = () => this.contract.removeListener(event, handler);
                this.contract.on(event, handler);
            });

            const ownerPubKey: string = await this.contract
                .connect(this.signer)
                .getInitiatorPublicKey();

            const encryptedPK = this._cipher.encryptStringHybrid(ownerPubKey, this.keys.publicKey);
            await this.contract
                .connect(this.signer)
                .publishEncryptedSenderPublicKey(JSON.stringify(encryptedPK));

            const encryptedKenc = await waitForKey;
            this.kenc = this._cipher.decryptStringHybrid(
                this.keys.privateKey,
                JSON.parse(encryptedKenc),
            );
            this._enrolled = true;
            success = true;
        } finally {
            if (!success) cleanup();
        }

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

    get cipher(): CipherProvider {
        return this._cipher;
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

        const encrypted = this._cipher.encryptStringHybrid(this.kenc, plainCid);
        const cidBytes = toUtf8Bytes(JSON.stringify(encrypted));
        return this.contract.connect(this.signer).publishIpfsCid(cidBytes, position);
    }

    // Withdraw
    async withdrawBond() {
        return this.contract.connect(this.signer).withdrawBond();
    }
}