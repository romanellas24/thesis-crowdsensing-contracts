/**
 * Abstraction over the hybrid encryption module.
 * Implementations must satisfy the same contract as `testUtils/cipher`.
 */
export interface CipherProvider {
    generateKeyPair(): KeyPair;
    generateEncryptionKeys(): EncryptionKeyPair;
    encryptStringHybrid(recipientPubKey: string, plaintext: string): HybridCiphertext;
    decryptStringHybrid(privateKey: string, ciphertext: HybridCiphertext): string;
}

export interface KeyPair {
    publicKey: string;
    privateKey: string;
}

export interface EncryptionKeyPair {
    encryptionKey: string;
    decryptionKey: string;
}

/**
 * Opaque hybrid-encryption payload (RSA-OAEP envelope + AES-256-GCM body).
 * Concrete shape depends on the cipher implementation; we only require
 * that it round-trips through JSON.stringify / JSON.parse.
 */
export type HybridCiphertext = object;

export enum VerificationResult {
    SUCCESS = 0,
    REJECTED = 1,
    CANNOT_COMPLETE = 2,
}

export type VerifyCallback = (decryptedCid: string, dataId: number) => VerificationResult;
