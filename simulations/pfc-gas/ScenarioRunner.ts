import {ethers} from "hardhat";
import cipher from "../../testUtils/cipher";
import {GasTracker} from "../shared/GasTracker";
import {
    buildContractConfig,
    TOTAL_CIDS,
    chunkForCid,
    positionForChunk,
} from "../shared/SimulationConfig";
import type {ContractTransaction, ContractTransactionResponse} from "ethers";
import fs from "node:fs";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * Runs a single (senders × verifiers) scenario.
 *
 * Design decisions:
 *   - Direct contract calls instead of actor classes => per-function gas
 *     granularity matching Table I (sender_pubkey vs owner_send_kenc).
 *   - Mock CID bytes for data submission => same on-chain gas, no hybrid
 *     encryption overhead (wall-clock savings for 10k submissions).
 *   - Cipher used only for enrollment (SC validates the key-exchange flow).
 *   - Wallets derived from Hardhat's mnemonic at indices > 20 to avoid
 *     collision with default signers.
 */
export class ScenarioRunner {

    private readonly senderCount: number;
    private readonly verifierCount: number;
    private readonly tracker = new GasTracker();
    private readonly config: ReturnType<typeof buildContractConfig>;
    private readonly ownerKeys = cipher.generateKeyPair();
    private readonly encryptionKeys = cipher.generateEncryptionKeys();

    // Populated during run()
    private contract!: any;
    private dstToken!: any;
    private ownerSigner!: any;
    private senderWallets: any[] = [];
    private verifierWallets: any[] = [];

    constructor(senders: number, verifiers: number) {
        this.senderCount = senders;
        this.verifierCount = verifiers;
        this.config = buildContractConfig(senders, verifiers);
    }

    async run(): Promise<string[]> {
        this.tracker.setRawPrefix(this.senderCount, this.verifierCount);
        const t0 = Date.now();

        await this.deploy();
        this.log("Contract deployed");

        await this.createAndFundWallets();
        this.log("Wallets funded");

        await this.enrollSenders();
        this.log(`${this.senderCount} senders enrolled`);

        await this.enrollVerifiers();
        this.log(`${this.verifierCount} verifiers enrolled`);

        await this.paySenderBonds();
        this.log("Sender bonds paid");

        await this.payVerifierBonds();
        this.log("Verifier bonds paid");

        await this.submitAllCids();
        this.log(`${TOTAL_CIDS} CIDs submitted`);

        await this.verifyAll();
        this.log("Verification complete");

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        this.log(`Scenario done in ${elapsed}s`);

        const out: string[] = this.tracker.toCsvRows(this.senderCount, this.verifierCount);
        this.tracker.clear();
        this.cleanup();

        return out;

    }

    private cleanup(): void {
        this.senderWallets = [];
        this.verifierWallets = [];
        this.contract = null;
        this.dstToken = null;
        this.ownerSigner = null;
    }

    // Deploy
    private async deploy(): Promise<void> {
        const [deployer] = await ethers.getSigners();
        this.ownerSigner = deployer;

        // DST Token
        const DSTFactory = await ethers.getContractFactory("DataSentTokenContract");
        const totalMint = 1_000_000_000;
        this.dstToken = await DSTFactory.deploy(totalMint);
        await this.dstToken.waitForDeployment();

        // Privacy Contract
        const PCFactory = await ethers.getContractFactory("PrivacyFirstContract");
        const deployTx = await PCFactory.deploy(
            this.ownerKeys.publicKey,
            this.config,
            await this.dstToken.getAddress(),
        );
        this.contract = await deployTx.waitForDeployment();
        const deployReceipt = await deployTx.deploymentTransaction()!.wait();
        this.tracker.record("contract_deployment", deployReceipt!.gasUsed, "owner");

        // Initial supply
        const approveTx = await this.dstToken.connect(this.ownerSigner)
            .approve(await this.contract.getAddress(), this.config.rewardConfig.totalDst);
        await approveTx.wait();
        const supplyTx = await this.contract.connect(this.ownerSigner).payInitialSupply();
        const supplyReceipt = await supplyTx.wait();
        this.tracker.record("initial_supply", supplyReceipt!.gasUsed, "owner");
    }

    private async createAndFundWallets(): Promise<void> {
        const provider = ethers.provider;
        const hdNode = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, "", "m/44'/60'/0'/0");
        const contractAddr = await this.contract.getAddress();

        const total = this.senderCount + this.verifierCount;

        for (let i = 0; i < total; i++) {
            // Indices 100+ to avoid collision with default Hardhat signers
            const wallet = hdNode.deriveChild(i + 100).connect(provider);

            // Fund ETH (for gas)
            await provider.send("hardhat_setBalance", [
                wallet.address,
                "0x" + (10n ** 20n).toString(16), // 100 ETH
            ]);

            if (i < this.senderCount) {
                this.senderWallets.push(wallet);
            } else {
                this.verifierWallets.push(wallet);
            }
        }

        // Fund DST for bonds
        const senderBond = BigInt(this.config.needs.maxDataPerSender) *
            BigInt(this.config.rewardConfig.dataSenderBondPerData);
        const verifierBond = BigInt(this.config.needs.maxDataPerVerifierPerBond) *
            BigInt(this.config.rewardConfig.dataVerifierBondPerData);

        for (const w of this.senderWallets) {
            await this.dstToken.transfer(w.address, senderBond);
        }
        for (const w of this.verifierWallets) {
            await this.dstToken.transfer(w.address, verifierBond);
        }
    }

    // Enrollment - per-tx gas tracking
    private async enrollSenders(): Promise<void> {
        for (let i = 0; i < this.senderCount; i++) {
            const wallet = this.senderWallets[i];
            const keys = cipher.generateKeyPair();
            const ownerPubKey = await this.contract.connect(wallet).getInitiatorPublicKey();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);

            // Sender publishes encrypted PK
            const tx1 = await this.contract.connect(wallet)
                .publishEncryptedSenderPublicKey(JSON.stringify(encryptedPK));
            const r1 = await tx1.wait();
            this.tracker.record("sender_upload_pubkey", r1!.gasUsed, "sender", i);

            // Owner decrypts sender PK, encrypts Kenc, publishes
            const senderPubKey = cipher.decryptStringHybrid(
                this.ownerKeys.privateKey, encryptedPK);
            const encKenc = cipher.encryptStringHybrid(
                senderPubKey, this.encryptionKeys.encryptionKey);
            const tx2 = await this.contract.connect(this.ownerSigner)
                .publishSenderEncryptionKey(wallet.address, JSON.stringify(encKenc));
            const r2 = await tx2.wait();
            this.tracker.record("owner_send_kenc", r2!.gasUsed, "owner");

            if ((i + 1) % 100 === 0) this.log(`  Enrolled ${i + 1}/${this.senderCount} senders`);
        }
    }

    private async enrollVerifiers(): Promise<void> {
        for (let i = 0; i < this.verifierCount; i++) {
            const wallet = this.verifierWallets[i];
            const keys = cipher.generateKeyPair();
            const ownerPubKey = await this.contract.connect(wallet).getInitiatorPublicKey();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);

            // Verifier publishes encrypted PK
            const tx1 = await this.contract.connect(wallet)
                .publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPK));
            const r1 = await tx1.wait();
            this.tracker.record("verifier_upload_pubkey", r1!.gasUsed, "verifier", i);

            // Owner decrypts verifier PK, encrypts Kdec, publishes
            const verifierPubKey = cipher.decryptStringHybrid(
                this.ownerKeys.privateKey, encryptedPK);
            const encKdec = cipher.encryptStringHybrid(
                verifierPubKey, this.encryptionKeys.decryptionKey);
            const tx2 = await this.contract.connect(this.ownerSigner)
                .publishVerifierDecryptionKey(wallet.address, JSON.stringify(encKdec));
            const r2 = await tx2.wait();
            this.tracker.record("owner_send_kdec", r2!.gasUsed, "owner");

            if ((i + 1) % 100 === 0) this.log(`  Enrolled ${i + 1}/${this.verifierCount} verifiers`);
        }
    }

    // Bonds
    private async paySenderBonds(): Promise<void> {
        const contractAddr = await this.contract.getAddress();
        const required = await this.contract.getRequiredSenderBond();

        for (let i = 0; i < this.senderCount; i++) {
            const wallet = this.senderWallets[i];
            await this.dstToken.connect(wallet).approve(contractAddr, required);
            const tx = await this.contract.connect(wallet).senderPayBond();
            const r = await tx.wait();
            this.tracker.record("sender_pay_bond", r!.gasUsed, "sender", i);
        }
    }

    private async payVerifierBonds(): Promise<void> {
        const contractAddr = await this.contract.getAddress();
        const required = await this.contract.getRequiredVerifierBond();

        for (let i = 0; i < this.verifierCount; i++) {
            const wallet = this.verifierWallets[i];
            await this.dstToken.connect(wallet).approve(contractAddr, required);
            const tx = await this.contract.connect(wallet).verifierPayBond();
            const r = await tx.wait();
            this.tracker.record("verifier_pay_bond", r!.gasUsed, "verifier", i);
        }
    }

    // Data submission - mock CIDs, random chunk positions
    private async submitAllCids(): Promise<void> {
        const txs: any[] = [];
        const senderIndices: number[] = [];

        for (let i = 0; i < TOTAL_CIDS; i++) {
            const senderIdx = i % this.senderCount;
            const wallet = this.senderWallets[senderIdx];
            const cid = ethers.toUtf8Bytes(`QmSimCid_${i}`);
            const position = positionForChunk(chunkForCid(i));

            const tx = await this.contract.connect(wallet).publishIpfsCid(cid, position);
            txs.push(tx);
            senderIndices.push(senderIdx);

            if ((i + 1) % 1000 === 0) this.log(`  Submitted ${i + 1}/${TOTAL_CIDS} CIDs`);
        }

        // Collect receipts in batch
        this.log("  Collecting receipts...");
        for (let i = 0; i < txs.length; i++) {
            const r = await txs[i].wait();
            this.tracker.record("data_submission", r!.gasUsed, "sender", senderIndices[i]);
        }
    }

    // Verification - round-robin verifiers, all SUCCESS
    private async verifyAll(): Promise<void> {
        let totalChecks = 0;
        let pendingExists = true;

        while (pendingExists) {
            pendingExists = false;

            for (let vi = 0; vi < this.verifierCount; vi++) {
                const wallet = this.verifierWallets[vi];

                try {
                    // Request verification slot
                    const txReq = await this.contract.connect(wallet).requestAuthToVerify();
                    const rReq = await txReq.wait();
                    this.tracker.record("verification_request", rReq!.gasUsed, "verifier", vi);

                    // Submit SUCCESS (enum value 0)
                    const txSub = await this.contract.connect(wallet).submitVerifyResult(0);
                    const rSub = await txSub.wait();
                    this.tracker.record("verification_submit", rSub!.gasUsed, "verifier", vi);

                    totalChecks++;
                    pendingExists = true;
                } catch (e: any) {
                    if (!e.message?.includes("No data available") &&
                        !e.message?.includes("Already verifying")) {
                        this.log(`  Unexpected error V${vi}: ${e.message}`);
                    }
                }
            }

            if (totalChecks % 1000 === 0 && totalChecks > 0) {
                this.log(`  ${totalChecks} verification checks completed`);
            }
        }

        this.log(`  Total verification checks: ${totalChecks}`);
    }

    private log(msg: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`  [${ts}] [${this.senderCount}S×${this.verifierCount}V] ${msg}`);
    }

    public setRawStream(stream: fs.WriteStream) {
        this.tracker.setRawStream(stream);
    }

}
