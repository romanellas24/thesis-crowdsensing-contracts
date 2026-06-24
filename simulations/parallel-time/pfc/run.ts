/**
 * Parallel-time simulation — PFC.
 *
 * Measures how many blocks N concurrent PFC campaigns consume.
 * N ∈ {1, 2, 4, 8, 16}, each campaign: 1000 senders, 100 verifiers, 5000 CIDs.
 *
 * Prerequisites — add to hardhat.config.ts under networks.hardhat:
 *   blockGasLimit: 60_000_000,   // Ethereum mainnet post-Fusaka (EIP-7935)
 *   mining: { auto: false, interval: 200 }
 *
 * Or run with the env-var toggle described in the README and read in your config:
 *   PARALLEL_TIME_SIM=true npx hardhat run simulations/parallel-time/pfc/run.ts
 *
 * Output: results/pfc_parallel_time.csv
 *
 * Resume behaviour: (N, PFC) rows already in the CSV are skipped automatically.
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
import { PfcCampaignRunner } from "./CampaignRunner";

const OUTPUT_FILE = "results/pfc_parallel_time.csv";
const CONTRACT    = "PFC" as const;

//  Hardhat network sanity-check 

async function assertNetworkConfig(): Promise<void> {
    const block = await ethers.provider.getBlock("latest");
    const limit = block!.gasLimit;

    if (limit > BigInt(BLOCK_GAS_LIMIT) * 4n) {
        console.error(
            `\n❌  Block gas limit is ${limit.toLocaleString()} gas.\n` +
            `   This simulation requires blockGasLimit: ${BLOCK_GAS_LIMIT.toLocaleString()} ` +
            `(Ethereum mainnet post-Fusaka).\n` +
            `   Add to hardhat.config.ts → networks.hardhat:\n` +
            `     blockGasLimit: ${BLOCK_GAS_LIMIT},\n` +
            `     mining: { auto: false, interval: ${MINING_INTERVAL_MS} }\n`,
        );
        process.exit(1);
    }
    console.log(`✔  Block gas limit: ${limit.toLocaleString()} gas`);
}

//  Main 

async function main(): Promise<void> {
    await assertNetworkConfig();
    ensureFile(OUTPUT_FILE);

    const allSigners = await ethers.getSigners(); // Hardhat gives 20 by default
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
        console.log(`  Running N=${N} concurrent PFC campaigns`);
        console.log(`${"═".repeat(60)}`);

        // Reset chain state between N-batches.
        // hardhat_reset also resets the mining mode → re-set interval mining.
        await ethers.provider.send("hardhat_reset", []);
        await ethers.provider.send("evm_setAutomine",       [false]);
        await ethers.provider.send("evm_setIntervalMining", [MINING_INTERVAL_MS]);

        // Each campaign gets a dedicated owner signer (no nonce conflicts).
        const runners = Array.from(
            { length: N },
            (_, i) => new PfcCampaignRunner(i, allSigners[i]),
        );

        // Snapshot the current block so all campaigns share the same startBlock.
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
