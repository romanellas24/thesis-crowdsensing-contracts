// rsa.ts
import {generateKeyPairSync, publicEncrypt, privateDecrypt, randomBytes, createCipheriv, createDecipheriv} from "crypto";

export default {

    generateKeyPair(): { publicKey: string, privateKey: string } {
        const {publicKey: publicKey, privateKey: secretKey} = generateKeyPairSync("rsa", {
            modulusLength: 4096,
            publicKeyEncoding: {type: "spki", format: "pem"},
            privateKeyEncoding: {type: "pkcs8", format: "pem"}
        });
        return {publicKey: publicKey, privateKey: secretKey};
    },

    generateEncryptionKeys(): { encryptionKey: string, decryptionKey: string } {
        const {publicKey: encryptionKey, privateKey: decryptionKey} = generateKeyPairSync("rsa", {
            modulusLength: 2048, // 3072/4096 for higher security
            publicKeyEncoding: {type: "spki", format: "pem"},
            privateKeyEncoding: {type: "pkcs8", format: "pem"}
        });
        return {encryptionKey: encryptionKey, decryptionKey: decryptionKey};
    },
    rsaEncrypt(encryptionKey: string, data: Buffer | string): Buffer {
        return publicEncrypt(
            {key: encryptionKey, padding: 4, oaepHash: "sha256"}, // RSA_PKCS1_OAEP_PADDING = 4
            Buffer.isBuffer(data) ? data : Buffer.from(data)
        );
    },

    rsaDecrypt(decryptionKey: string, ciphertext: Buffer): Buffer {
        return privateDecrypt(
            {key: decryptionKey, padding: 4, oaepHash: "sha256"},
            ciphertext
        );
    },

    encryptStringHybrid(key: string, plaintext: string) : {
        tag: string, encKey: string, iv: string, ct: string
    }{
        const cek = randomBytes(32);           // AES-256 key
        const iv = randomBytes(12);           // 96-bit nonce for GCM
        const cipher = createCipheriv("aes-256-gcm", cek, iv);

        const ptBuf = Buffer.from(plaintext, "utf8");
        const ciphertext = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
        const tag = cipher.getAuthTag();

        const encKey = publicEncrypt(
            {key: key, padding: 4, oaepHash: "sha256"}, // RSA_PKCS1_OAEP_PADDING
            cek
        );

        return {
            iv: iv.toString("base64"),
            tag: tag.toString("base64"),
            encKey: encKey.toString("base64"),
            ct: ciphertext.toString("base64"),
        };
    },

    decryptStringHybrid(key: string, bundle: {
        tag: string, encKey: string, iv: string, ct: string
    }) {
        const cek = privateDecrypt(
            {key: key, padding: 4, oaepHash: "sha256"},
            Buffer.from(bundle.encKey, "base64")
        );

        const iv = Buffer.from(bundle.iv, "base64");
        const tag = Buffer.from(bundle.tag, "base64");
        const ct = Buffer.from(bundle.ct, "base64");

        const decipher = createDecipheriv("aes-256-gcm", cek, iv);
        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
        return plaintext.toString("utf8");
    },


}