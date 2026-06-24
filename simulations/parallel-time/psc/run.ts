/**
 * Parallel-time simulation — PSC.
 *
 * Same structure as the PFC run, but uses PrivacySecondContract.
 * PSC campaigns have three extra owner operations per CID:
 *   - notifyVerificationKeyReady  (after each sender submission)
 *   - deliverVerificationBundle   (once per verification slot)
 *
 * This additional owner load makes PSC campaigns heavier and is expected to
 * show higher block counts than PFC under contention — the core thesis argument.
 *
 * Prerequisites — same as pfc/run.ts:
 *   networks.hardhat.blockGasLimit: 60_000_000
 *   networks.hardhat.mining: { auto: false, interval: 200 }
 *
 * Output: results/psc_parallel_time.csv
 */

import { ethers } from "hardhat";
import {
    CAMPAIGN_SIZES,
    BLOCK_GAS_LIMIT,
    MINING_INTERVAL_MS,
} from "../shared/ParallelTimeConfig";
import {
    ensureFile,
    isAlreadyCompleted,
    appendResult,
    computeResult,
    type CampaignBlockResult,
} from "../shared/TimeTracker";
import { PscCampaignRunner } from "./CampaignRunner";

const OUTPUT_FILE = "results/psc_parallel_time.csv";
const CONTRACT    = "PSC" as const;

async function assertNetworkConfig(): Promise<void> {
    const block = await ethers.provider.getBlock("latest");
    const limit = block!.gasLimit;

    if (limit > BigInt(BLOCK_GAS_LIMIT) * 4n) {
        console.error(
            `\n❌  Block gas limit is ${limit.toLocaleString()} gas.\n` +
            `   This simulation requires blockGasLimit: ${BLOCK_GAS_LIMIT.toLocaleString()}.\n` +
            `   Add to hardhat.config.ts → networks.hardhat:\n` +
            `     blockGasLimit: ${BLOCK_GAS_LIMIT},\n` +
            `     mining: { auto: false, interval: ${MINING_INTERVAL_MS} }\n`,
        );
        process.exit(1);
    }
    console.log(`✔  Block gas limit: ${limit.toLocaleString()} gas`);
}

async function main(): Promise<void> {
    await assertNetworkConfig();
    ensureFile(OUTPUT_FILE);

    const allSigners = await ethers.getSigners();
    console.log(`Available owner signers: ${allSigners.length}`);

    for (const N of CAMPAIGN_SIZES) {
        if (N > allSigners.length) {
            console.warn(`⚠  N=${N} requires ${N} owner signers but only ${allSigners.length} are available. Skipping.`);
            continue;
        }

        if (isAlreadyCompleted(OUTPUT_FILE, N, CONTRACT)) {
            console.log(`  Skipping N=${N} (already in CSV)`);
            continue;
        }

        console.log(`\n${"═".repeat(60)}`);
        console.log(`  Running N=${N} concurrent PSC campaigns`);
        console.log(`${"═".repeat(60)}`);

        await ethers.provider.send("hardhat_reset", []);
        await ethers.provider.send("evm_setAutomine",       [false]);
        await ethers.provider.send("evm_setIntervalMining", [MINING_INTERVAL_MS]);

        const runners = Array.from(
            { length: N },
            (_, i) => new PscCampaignRunner(i, allSigners[i]),
        );

        const startBlock = await ethers.provider.getBlockNumber();
        console.log(`  Start block: ${startBlock}`);

        const t0      = Date.now();
        const results: CampaignBlockResult[] = await Promise.all(
            runners.map(r => r.run(startBlock)),
        );
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        const scenario = computeResult(N, CONTRACT, results);

        console.log(`\n  Results for N=${N}:`);
        results.forEach(r =>
            console.log(`    Campaign ${r.campaignIndex}: ${r.blocksUsed} blocks (end=${r.endBlock})`),
        );
        console.log(`  Mean blocks: ${scenario.meanBlocks.toFixed(2)}`);
        console.log(`  Wall-clock:  ${elapsed}s`);

        appendResult(OUTPUT_FILE, scenario);
        console.log(`  ✔ Saved to ${OUTPUT_FILE}`);
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Simulation complete — ${OUTPUT_FILE}`);
    console.log(`${"═".repeat(60)}\n`);
}

main().catch(err => {
    console.error("Simulation failed:", err);
    process.exit(1);
});
