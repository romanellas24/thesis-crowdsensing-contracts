import { ethers } from "hardhat";
import cipher from "../../../testUtils/cipher";
import {
    SENDERS_PER_CAMPAIGN,
    VERIFIERS_PER_CAMPAIGN,
    TOTAL_CIDS,
    CHECKS_REQUIRED,
    MAJORITY,
    HARDHAT_MNEMONIC,
    WALLET_BASE_INDEX,
    WALLETS_PER_CAMPAIGN,
} from "../shared/ParallelTimeConfig";
import { chunkForCid, positionForChunk } from "../shared/chunkUtils";
import type { CampaignBlockResult } from "../shared/TimeTracker";

/**
 * Single PFC campaign runner for the parallel-time simulation.
 *
 * Parallelisation strategy:
 *   - Sender/verifier operations that are independent (enrollment phase 1,
 *     bond payments, CID submissions) run via Promise.all over all actors of
 *     THIS campaign in parallel.
 *   - The owner's sequential responses (enrollment phase 2) are sent without
 *     per-tx await using explicit nonce management, then confirmed in batch.
 *   - Verification rounds are parallelised across verifiers inside this
 *     campaign via Promise.all.
 *
 * When the orchestrator runs N CampaignRunners in Promise.all, all the above
 * happens concurrently across campaigns, flooding the mempool and exposing
 * real block-gas contention at the 60 M gas Fusaka limit.
 *
 * Block tracking:
 *   startBlock – recorded by the ORCHESTRATOR before Promise.all fires.
 *   endBlock   – max blockNumber across all confirmed tx receipts inside run().
 */
export class PfcCampaignRunner {

    private readonly campaignIndex: number;
    private readonly ownerSigner:   any;

    private readonly ownerKeys       = cipher.generateKeyPair();
    private readonly encryptionKeys  = cipher.generateEncryptionKeys();

    // Populated during run()
    private contract!:        any;
    private dstToken!:        any;
    private senderWallets:    any[]  = [];
    private verifierWallets:  any[]  = [];

    // Key material cached from enrollment phase 1 (needed for phase 2).
    // Index = actor index within this campaign.
    private senderKeyCache:   Array<{ keys: any; encryptedPK: any }> = [];
    private verifierKeyCache: Array<{ keys: any; encryptedPK: any }> = [];

    endBlock = 0;  // read by orchestrator after run() resolves

    constructor(campaignIndex: number, ownerSigner: any) {
        this.campaignIndex = campaignIndex;
        this.ownerSigner   = ownerSigner;
    }

    //  Public entry point 

    async run(startBlock: number): Promise<CampaignBlockResult> {
        this.endBlock = startBlock;

        await this.deploy();
        await this.createAndFundWallets();
        await this.enrollSenders();
        await this.enrollVerifiers();
        await this.payBonds();
        await this.submitCids();
        await this.verifyAll();

        return {
            campaignIndex: this.campaignIndex,
            startBlock,
            endBlock:    this.endBlock,
            blocksUsed:  this.endBlock - startBlock,
        };
    }

    //  Helpers 

    private updateEnd(blockNumber: number): void {
        if (blockNumber > this.endBlock) this.endBlock = blockNumber;
    }

    private log(msg: string): void {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`  [${ts}] [PFC-C${this.campaignIndex}] ${msg}`);
    }

    private buildConfig() {
        const maxDataPerSender           = Math.ceil(TOTAL_CIDS / SENDERS_PER_CAMPAIGN);
        const maxDataPerVerifierPerBond  = Math.ceil((TOTAL_CIDS * MAJORITY) / VERIFIERS_PER_CAMPAIGN);
        return {
            needs: {
                dataNeeded:            0,
                minimumParticipants:   0,
                checksRequired:        CHECKS_REQUIRED,
                verifierCooldown:      1,
                verificationTimeout:   86400,
                maxDataPerSender,
                maxDataPerVerifierPerBond,
                maximumDataPerChunk:   0,
            },
            rewardConfig: {
                totalDst:                1_000_000,
                dataSenderPayout:        10,
                dataVerifierPayout:      5,
                dataSenderBondPerData:   1,
                dataVerifierBondPerData: 1,
            },
            originCoordinates: {
                latitudeInteger:  41,
                latitudeDecimal:  0,
                longitudeInteger: 11,
                longitudeDecimal: 0,
            },
            chunkConfig: {
                chunkSize:  1_000_000,
                chunk4Side: 10,
            },
        };
    }

    //  Deploy 

    private async deploy(): Promise<void> {
        const config = this.buildConfig();

        const DSTFactory = await ethers.getContractFactory("DataSentTokenContract");
        this.dstToken = await DSTFactory.connect(this.ownerSigner).deploy(100_000_000);
        await this.dstToken.waitForDeployment();
        const dstDeploy = await this.dstToken.deploymentTransaction()!.wait();
        this.updateEnd(dstDeploy!.blockNumber);

        const PFCFactory = await ethers.getContractFactory("PrivacyFirstContract");
        const pfcTx = await PFCFactory.connect(this.ownerSigner).deploy(
            this.ownerKeys.publicKey,
            config,
            await this.dstToken.getAddress(),
        );
        this.contract = await pfcTx.waitForDeployment();
        const pfcDeploy = await pfcTx.deploymentTransaction()!.wait();
        this.updateEnd(pfcDeploy!.blockNumber);

        const approveTx = await this.dstToken.connect(this.ownerSigner)
            .approve(await this.contract.getAddress(), config.rewardConfig.totalDst);
        this.updateEnd((await approveTx.wait())!.blockNumber);

        const supplyTx = await this.contract.connect(this.ownerSigner).payInitialSupply();
        this.updateEnd((await supplyTx.wait())!.blockNumber);
    }

    //  Wallet creation & DST funding 

    private async createAndFundWallets(): Promise<void> {
        const provider = ethers.provider;
        const hdNode   = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, "", "m/44'/60'/0'/0");
        const base     = WALLET_BASE_INDEX + this.campaignIndex * WALLETS_PER_CAMPAIGN;
        const config   = this.buildConfig();

        // Derive wallets and set ETH balance
        for (let i = 0; i < SENDERS_PER_CAMPAIGN + VERIFIERS_PER_CAMPAIGN; i++) {
            const wallet = hdNode.deriveChild(base + i).connect(provider);
            await provider.send("hardhat_setBalance", [
                wallet.address,
                "0x" + (10n ** 20n).toString(16),  // 100 ETH
            ]);
            if (i < SENDERS_PER_CAMPAIGN) this.senderWallets.push(wallet);
            else                           this.verifierWallets.push(wallet);
        }

        // DST transfer: batch-send from owner (nonce-managed) then confirm all.
        const senderBond   = BigInt(config.needs.maxDataPerSender)          * BigInt(config.rewardConfig.dataSenderBondPerData);
        const verifierBond = BigInt(config.needs.maxDataPerVerifierPerBond)  * BigInt(config.rewardConfig.dataVerifierBondPerData);

        let nonce = await this.ownerSigner.getNonce();
        const transferPromises: Promise<any>[] = [];

        for (const w of this.senderWallets) {
            const tx = await this.dstToken.connect(this.ownerSigner)
                .transfer(w.address, senderBond, { nonce: nonce++ });
            transferPromises.push(tx.wait());
        }
        for (const w of this.verifierWallets) {
            const tx = await this.dstToken.connect(this.ownerSigner)
                .transfer(w.address, verifierBond, { nonce: nonce++ });
            transferPromises.push(tx.wait());
        }

        const receipts = await Promise.all(transferPromises);
        receipts.forEach(r => r && this.updateEnd(r.blockNumber));
        this.log(`Wallets funded (${SENDERS_PER_CAMPAIGN}S + ${VERIFIERS_PER_CAMPAIGN}V)`);
    }

    //  Enrollment 

    /**
     * Sender enrollment.
     *
     * Phase 1: all senders call publishEncryptedSenderPublicKey in parallel.
     *          Key material is cached locally (no chain read needed for phase 2).
     * Phase 2: owner publishes Kenc to every sender; nonce-managed batch.
     */
    private async enrollSenders(): Promise<void> {
        const ownerPubKey = await this.contract.connect(this.ownerSigner).getInitiatorPublicKey();

        // Phase 1 — parallel sender txs
        const phase1Promises = this.senderWallets.map(async (wallet, i) => {
            const keys       = cipher.generateKeyPair();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);
            this.senderKeyCache[i] = { keys, encryptedPK };

            const tx = await this.contract.connect(wallet)
                .publishEncryptedSenderPublicKey(JSON.stringify(encryptedPK));
            this.updateEnd((await tx.wait())!.blockNumber);
        });
        await Promise.all(phase1Promises);

        // Phase 2 — owner batch (nonce-managed)
        let nonce = await this.ownerSigner.getNonce();
        const phase2Promises: Promise<any>[] = [];

        for (let i = 0; i < SENDERS_PER_CAMPAIGN; i++) {
            const { keys, encryptedPK } = this.senderKeyCache[i];
            const senderPubKey = cipher.decryptStringHybrid(this.ownerKeys.privateKey, encryptedPK);
            const encKenc      = cipher.encryptStringHybrid(senderPubKey, this.encryptionKeys.encryptionKey);

            const tx = await this.contract.connect(this.ownerSigner)
                .publishSenderEncryptionKey(
                    this.senderWallets[i].address,
                    JSON.stringify(encKenc),
                    { nonce: nonce++ },
                );
            phase2Promises.push(tx.wait());
        }

        const receipts = await Promise.all(phase2Promises);
        receipts.forEach(r => r && this.updateEnd(r.blockNumber));
        this.log(`${SENDERS_PER_CAMPAIGN} senders enrolled`);
    }

    /**
     * Verifier enrollment (PFC).
     * Same two-phase pattern as senders, but the key being shared is Kdec.
     */
    private async enrollVerifiers(): Promise<void> {
        const ownerPubKey = await this.contract.connect(this.ownerSigner).getInitiatorPublicKey();

        // Phase 1 — parallel verifier txs
        const phase1Promises = this.verifierWallets.map(async (wallet, i) => {
            const keys        = cipher.generateKeyPair();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);
            this.verifierKeyCache[i] = { keys, encryptedPK };

            const tx = await this.contract.connect(wallet)
                .publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPK));
            this.updateEnd((await tx.wait())!.blockNumber);
        });
        await Promise.all(phase1Promises);

        // Phase 2 — owner batch (nonce-managed)
        let nonce = await this.ownerSigner.getNonce();
        const phase2Promises: Promise<any>[] = [];

        for (let i = 0; i < VERIFIERS_PER_CAMPAIGN; i++) {
            const { keys, encryptedPK } = this.verifierKeyCache[i];
            const verifierPubKey = cipher.decryptStringHybrid(this.ownerKeys.privateKey, encryptedPK);
            const encKdec        = cipher.encryptStringHybrid(verifierPubKey, this.encryptionKeys.decryptionKey);

            const tx = await this.contract.connect(this.ownerSigner)
                .publishVerifierDecryptionKey(
                    this.verifierWallets[i].address,
                    JSON.stringify(encKdec),
                    { nonce: nonce++ },
                );
            phase2Promises.push(tx.wait());
        }

        const receipts = await Promise.all(phase2Promises);
        receipts.forEach(r => r && this.updateEnd(r.blockNumber));
        this.log(`${VERIFIERS_PER_CAMPAIGN} verifiers enrolled`);
    }

    //  Bond payments 

    /**
     * Bonds: each actor does approve + payBond independently.
     * All actors (senders + verifiers) run in parallel.
     * approve must complete before payBond for the same wallet => sequential
     * within each actor, parallel across actors.
     */
    private async payBonds(): Promise<void> {
        const contractAddr     = await this.contract.getAddress();
        const senderRequired   = await this.contract.getRequiredSenderBond();
        const verifierRequired = await this.contract.getRequiredVerifierBond();

        const senderPromises = this.senderWallets.map(async (wallet) => {
            await this.dstToken.connect(wallet).approve(contractAddr, senderRequired);
            const tx = await this.contract.connect(wallet).senderPayBond();
            this.updateEnd((await tx.wait())!.blockNumber);
        });

        const verifierPromises = this.verifierWallets.map(async (wallet) => {
            await this.dstToken.connect(wallet).approve(contractAddr, verifierRequired);
            const tx = await this.contract.connect(wallet).verifierPayBond();
            this.updateEnd((await tx.wait())!.blockNumber);
        });

        await Promise.all([...senderPromises, ...verifierPromises]);
        this.log("Bonds paid");
    }

    //  CID submission 

    /**
     * CID submission: distribute TOTAL_CIDS across senders in round-robin.
     * Each sender sends its own subset sequentially (no nonce conflicts),
     * all senders run in parallel.
     */
    private async submitCids(): Promise<void> {
        // Pre-compute each sender's CID list
        const senderCids: number[][] = Array.from({ length: SENDERS_PER_CAMPAIGN }, () => []);
        for (let i = 0; i < TOTAL_CIDS; i++) {
            senderCids[i % SENDERS_PER_CAMPAIGN].push(i);
        }

        const senderPromises = this.senderWallets.map(async (wallet, senderIdx) => {
            for (const cidIdx of senderCids[senderIdx]) {
                const cid      = ethers.toUtf8Bytes(`QmSimCid_${this.campaignIndex}_${cidIdx}`);
                const position = positionForChunk(chunkForCid(cidIdx));
                const tx       = await this.contract.connect(wallet).publishIpfsCid(cid, position);
                this.updateEnd((await tx.wait())!.blockNumber);
            }
        });

        await Promise.all(senderPromises);
        this.log(`${TOTAL_CIDS} CIDs submitted`);
    }

    //  Verification 

    /**
     * Verification (PFC): request slot => submit result.
     * All verifiers attempt in parallel per round; rounds repeat until no
     * pending data remains.
     */
    private async verifyAll(): Promise<void> {
        let totalChecks  = 0;
        let pendingExist = true;

        while (pendingExist) {
            pendingExist = false;

            const roundPromises = this.verifierWallets.map(async (wallet, vi) => {
                try {
                    const txReq = await this.contract.connect(wallet).requestAuthToVerify();
                    this.updateEnd((await txReq.wait())!.blockNumber);

                    const txSub = await this.contract.connect(wallet).submitVerifyResult(0); // SUCCESS
                    this.updateEnd((await txSub.wait())!.blockNumber);

                    return true;
                } catch (e: any) {
                    if (!e.message?.includes("No data available") &&
                        !e.message?.includes("Already verifying")) {
                        this.log(`  Unexpected V${vi}: ${e.message}`);
                    }
                    return false;
                }
            });

            const results = await Promise.all(roundPromises);
            if (results.some(r => r)) {
                pendingExist = true;
                totalChecks += results.filter(r => r).length;
            }
        }

        this.log(`Verification done (${totalChecks} checks)`);
    }
}
