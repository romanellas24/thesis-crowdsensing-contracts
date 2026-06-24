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
    PSC_NOVEL_PARAMS,
    PSC_MAX_DATA_PER_CHUNK,
} from "../shared/ParallelTimeConfig";
import { chunkForCid, positionForChunk } from "../shared/chunkUtils";
import type { CampaignBlockResult } from "../shared/TimeTracker";

function buildMockBundle(dataId: number): Uint8Array {
    return ethers.toUtf8Bytes(`mock_bundle_${dataId}`);
}

/**
 * Single PSC campaign runner for the parallel-time simulation.
 *
 * Differences from PFC:
 *   1. Verifier enrollment (phase 2): owner passes "" — PSC does not publish Kdec.
 *   2. CID submission: after all senders submit, owner calls
 *      notifyVerificationKeyReady(dataId) for each CID (nonce-managed batch).
 *   3. Verification loop: owner must call deliverVerificationBundle() between
 *      requestAuthToVerify() and submitVerifyResult() for each slot.
 *
 * All other phases (deploy, funding, sender enrollment, bonds) are identical
 * to the PFC runner and are reproduced here for self-containment.
 */
export class PscCampaignRunner {

    private readonly campaignIndex: number;
    private readonly ownerSigner:   any;

    private readonly ownerKeys      = cipher.generateKeyPair();
    private readonly encryptionKeys = cipher.generateEncryptionKeys();

    private contract!:        any;
    private dstToken!:        any;
    private senderWallets:    any[] = [];
    private verifierWallets:  any[] = [];

    private senderKeyCache:   Array<{ keys: any; encryptedPK: any }> = [];
    private verifierKeyCache: Array<{ keys: any; encryptedPK: any }> = [];

    endBlock = 0;

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
        await this.submitCids();          // senders submit + owner notifyKeyReady
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
        console.log(`  [${ts}] [PSC-C${this.campaignIndex}] ${msg}`);
    }

    private buildConfig() {
        const maxDataPerSender           = Math.ceil(TOTAL_CIDS / SENDERS_PER_CAMPAIGN);
        // Use CHECKS_REQUIRED (not MAJORITY) so the bond covers the worst-case
        // where a single verifier is assigned all slots of a CID.
        const maxDataPerVerifierPerBond  = Math.ceil((TOTAL_CIDS * CHECKS_REQUIRED) / VERIFIERS_PER_CAMPAIGN);
        return {
            needs: {
                dataNeeded:            0,
                minimumParticipants:   0,
                checksRequired:        CHECKS_REQUIRED,
                verifierCooldown:      1,
                verificationTimeout:   86400,
                maxDataPerSender,
                maxDataPerVerifierPerBond,
                maximumDataPerChunk:   PSC_MAX_DATA_PER_CHUNK,
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
        this.updateEnd((await this.dstToken.deploymentTransaction()!.wait())!.blockNumber);

        const PSCFactory = await ethers.getContractFactory("PrivacySecondContract");
        const pscTx = await PSCFactory.connect(this.ownerSigner).deploy(
            this.ownerKeys.publicKey,
            config,
            await this.dstToken.getAddress(),
            PSC_NOVEL_PARAMS,
        );
        this.contract = await pscTx.waitForDeployment();
        this.updateEnd((await pscTx.deploymentTransaction()!.wait())!.blockNumber);

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

        for (let i = 0; i < SENDERS_PER_CAMPAIGN + VERIFIERS_PER_CAMPAIGN; i++) {
            const wallet = hdNode.deriveChild(base + i).connect(provider);
            await provider.send("hardhat_setBalance", [
                wallet.address,
                "0x" + (10n ** 20n).toString(16),
            ]);
            if (i < SENDERS_PER_CAMPAIGN) this.senderWallets.push(wallet);
            else                           this.verifierWallets.push(wallet);
        }

        const senderBond   = BigInt(config.needs.maxDataPerSender)         * BigInt(config.rewardConfig.dataSenderBondPerData);
        const verifierBond = BigInt(config.needs.maxDataPerVerifierPerBond) * BigInt(config.rewardConfig.dataVerifierBondPerData);

        let nonce = await this.ownerSigner.getNonce("pending");
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
        this.log(`Wallets funded`);
    }

    //  Enrollment 

    private async enrollSenders(): Promise<void> {
        const ownerPubKey = await this.contract.connect(this.ownerSigner).getInitiatorPublicKey();

        const phase1 = this.senderWallets.map(async (wallet, i) => {
            const keys        = cipher.generateKeyPair();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);
            this.senderKeyCache[i] = { keys, encryptedPK };

            const tx = await this.contract.connect(wallet)
                .publishEncryptedSenderPublicKey(JSON.stringify(encryptedPK));
            this.updateEnd((await tx.wait())!.blockNumber);
        });
        await Promise.all(phase1);

        let nonce = await this.ownerSigner.getNonce("pending");
        const phase2Promises: Promise<any>[] = [];

        for (let i = 0; i < SENDERS_PER_CAMPAIGN; i++) {
            const { encryptedPK } = this.senderKeyCache[i];
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

        (await Promise.all(phase2Promises)).forEach(r => r && this.updateEnd(r.blockNumber));
        this.log(`${SENDERS_PER_CAMPAIGN} senders enrolled`);
    }

    /**
     * PSC verifier enrollment: owner passes "" as the key argument.
     * publishVerifierDecryptionKey in PSC only emits VerifierEnrolled without
     * storing any key on-chain (§2.6.1 protocol).
     */
    private async enrollVerifiers(): Promise<void> {
        const ownerPubKey = await this.contract.connect(this.ownerSigner).getInitiatorPublicKey();

        const phase1 = this.verifierWallets.map(async (wallet, i) => {
            const keys        = cipher.generateKeyPair();
            const encryptedPK = cipher.encryptStringHybrid(ownerPubKey, keys.publicKey);
            this.verifierKeyCache[i] = { keys, encryptedPK };

            const tx = await this.contract.connect(wallet)
                .publishEncryptedVerifierPublicKey(JSON.stringify(encryptedPK));
            this.updateEnd((await tx.wait())!.blockNumber);
        });
        await Promise.all(phase1);

        let nonce = await this.ownerSigner.getNonce("pending");
        const phase2Promises: Promise<any>[] = [];

        for (let i = 0; i < VERIFIERS_PER_CAMPAIGN; i++) {
            // PSC: key arg is ignored on-chain → pass empty string
            const tx = await this.contract.connect(this.ownerSigner)
                .publishVerifierDecryptionKey(
                    this.verifierWallets[i].address,
                    "",
                    { nonce: nonce++ },
                );
            phase2Promises.push(tx.wait());
        }

        (await Promise.all(phase2Promises)).forEach(r => r && this.updateEnd(r.blockNumber));
        this.log(`${VERIFIERS_PER_CAMPAIGN} verifiers enrolled`);
    }

    //  Bond payments 

    private async payBonds(): Promise<void> {
        const contractAddr     = await this.contract.getAddress();
        const senderRequired   = await this.contract.getRequiredSenderBond();
        const verifierRequired = await this.contract.getRequiredVerifierBond();

        const senderPromises = this.senderWallets.map(async (wallet) => {
            const approveTx = await this.dstToken.connect(wallet).approve(contractAddr, senderRequired);
            await approveTx.wait();
            const tx = await this.contract.connect(wallet).senderPayBond();
            this.updateEnd((await tx.wait())!.blockNumber);
        });

        const verifierPromises = this.verifierWallets.map(async (wallet) => {
            const approveTx = await this.dstToken.connect(wallet).approve(contractAddr, verifierRequired);
            await approveTx.wait();
            const tx = await this.contract.connect(wallet).verifierPayBond();
            this.updateEnd((await tx.wait())!.blockNumber);
        });

        await Promise.all([...senderPromises, ...verifierPromises]);
        this.log("Bonds paid");
    }

    //  CID submission + owner notifyKeyReady 

    /**
     * PSC submission is a two-phase operation:
     *   1. All senders submit CIDs in parallel (each sender's CIDs are
     *      sequential to avoid nonce conflicts within a wallet).
     *   2. Owner calls notifyVerificationKeyReady for every dataId in order,
     *      using nonce-managed batch send.
     */
    private async submitCids(): Promise<void> {
        // Phase 1 — parallel sender submission
        const senderCids: number[][] = Array.from({ length: SENDERS_PER_CAMPAIGN }, () => []);
        for (let i = 0; i < TOTAL_CIDS; i++) {
            senderCids[i % SENDERS_PER_CAMPAIGN].push(i);
        }

        // Same retry logic as PFC: Hardhat interval-mining drops sub-call revert data
        // → data=null. Retry auto-increments nonce; succeeds in isolation next block.
        const CID_SUBMIT_MAX_RETRIES = 5;

        const senderPromises = this.senderWallets.map(async (wallet, senderIdx) => {
            for (const cidIdx of senderCids[senderIdx]) {
                const cid      = ethers.toUtf8Bytes(`QmSimCid_${this.campaignIndex}_${cidIdx}`);
                const position = positionForChunk(chunkForCid(cidIdx));

                let mined = false;
                let attempt = 0;
                while (!mined) {
                    attempt++;
                    const tx = await this.contract.connect(wallet).publishIpfsCid(cid, position);
                    try {
                        this.updateEnd((await tx.wait())!.blockNumber);
                        mined = true;
                    } catch (e: any) {
                        const isHardhatRace = e.code === "CALL_EXCEPTION" && e.data == null;
                        if (!isHardhatRace || attempt >= CID_SUBMIT_MAX_RETRIES) {
                            try {
                                await this.contract.connect(wallet).publishIpfsCid
                                    .staticCall(cid, position);
                                throw new Error(
                                    `[C${this.campaignIndex} S${senderIdx} CID${cidIdx}] ` +
                                    `${attempt} retries exhausted (data=null) — staticCall passes → Hardhat race.`,
                                );
                            } catch (staticErr: any) {
                                if (staticErr.message?.includes("retries exhausted")) throw staticErr;
                                throw new Error(
                                    `[C${this.campaignIndex} S${senderIdx} CID${cidIdx}] ` +
                                    `revert reason: ${staticErr.reason ?? staticErr.shortMessage ?? staticErr.message}`,
                                );
                            }
                        }
                        // data=null within retry budget — nonce auto-incremented, retry next block
                    }
                }
            }
        });
        await Promise.all(senderPromises);
        this.log(`${TOTAL_CIDS} CIDs submitted`);

        // Phase 2 — owner notifyVerificationKeyReady (nonce-managed batch)
        let nonce = await this.ownerSigner.getNonce("pending");
        const notifyPromises: Promise<any>[] = [];

        for (let dataId = 0; dataId < TOTAL_CIDS; dataId++) {
            const tx = await this.contract.connect(this.ownerSigner)
                .notifyVerificationKeyReady(dataId, { nonce: nonce++ });
            notifyPromises.push(tx.wait());
        }

        (await Promise.all(notifyPromises)).forEach(r => r && this.updateEnd(r.blockNumber));
        this.log(`${TOTAL_CIDS} key-ready notifications sent`);
    }

    //  Verification 

    /**
     * PSC verification loop per slot:
     *   verifier.requestAuthToVerify()
     *   owner.deliverVerificationBundle(dataId, verifier.address, bundle)
     *   verifier.submitVerifyResult(SUCCESS)
     *
     * Steps are strictly sequential per verifier (each step depends on the
     * previous). All verifiers of THIS campaign run in parallel per round.
     */
    private async verifyAll(): Promise<void> {
        let totalChecks  = 0;
        let pendingExist = true;

        while (pendingExist) {
            pendingExist = false;

            const roundPromises = this.verifierWallets.map(async (wallet, vi) => {
                try {
                    // 1. Request slot
                    const txReq = await this.contract.connect(wallet).requestAuthToVerify();
                    this.updateEnd((await txReq.wait())!.blockNumber);

                    // 2. Read dataId (free view call)
                    const dataId: bigint = await this.contract.connect(wallet).getActiveVerification();

                    // 3. Owner delivers bundle
                    const bundle   = buildMockBundle(Number(dataId));
                    const txBundle = await this.contract.connect(this.ownerSigner)
                        .deliverVerificationBundle(dataId, wallet.address, bundle);
                    this.updateEnd((await txBundle.wait())!.blockNumber);

                    // 4. Verifier submits result
                    const txSub = await this.contract.connect(wallet).submitVerifyResult(0); // SUCCESS
                    this.updateEnd((await txSub.wait())!.blockNumber);

                    return true;
                } catch (e: any) {
                    const msg = e.message ?? "";
                    const isKnown =
                        msg.includes("No data available") ||
                        msg.includes("Already verifying") ||
                        msg.includes("Campaign is closed") ||
                        (e.code === "CALL_EXCEPTION" && e.data == null);
                    if (!isKnown) {
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
