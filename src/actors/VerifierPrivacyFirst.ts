import {toUtf8String} from "ethers";
import {CipherProvider, KeyPair, VerificationResult, VerifyCallback} from "./CipherProvider";

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
export class VerifierPrivacyFirst {

    private readonly signer: any;
    private readonly contract: any;
    private readonly dstToken: any;
    private readonly cipher: CipherProvider;
    private verifyCallback: VerifyCallback;
    private keys: KeyPair | null = null;
    private kdec: string | null = null;
    private _enrolled = false;

    constructor(
        signer: any,
        contract: any,
        dstToken: any,
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

        const waitForKey = new Promise<string>((resolve) => {
            const handler = (verifier: string, decryptionKey: string) => {
                if (verifier !== this.signer.address) return;
                this.contract.removeListener("VerifierDecryptionKeyReady", handler);
                resolve(decryptionKey);
            };
            this.contract.on("VerifierDecryptionKeyReady", handler);
        });

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
    async requestAndVerify(): Promise<{dataId: number; decryptedCid: string; result: VerificationResult}> {
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
    async requestAuthToVerify(): Promise<{dataId: number; decryptedCid: string; slotIndex: number}> {
        if (!this.kdec) throw new Error("Not enrolled - Kdec not available");

        const tx = await this.contract.connect(this.signer).requestAuthToVerify();
        const receipt = await tx.wait();

        let dataId = -1;
        let slotIndex = -1;
        let encryptedCidHex = "";

        for (const log of receipt.logs) {
            try {
                const parsed = this.contract.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });
                if (parsed?.name === "VerifierElected") {
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
}