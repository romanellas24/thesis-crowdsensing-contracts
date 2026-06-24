/**
 * CSV output for the parallel-time simulation.
 *
 * Schema:
 *   N,CONTRACT,MEAN_BLOCKS,BLOCKS
 *
 * Fields:
 *   N            – number of concurrent campaigns in this run.
 *   CONTRACT     – "PFC" or "PSC".
 *   MEAN_BLOCKS  – arithmetic mean of blocks used across all N campaigns.
 *   BLOCKS       – JSON array [B1, B2, …, BN] where Bi = endBlock_i − startBlock
 *                  (startBlock is shared; it is recorded just before Promise.all fires).
 *
 * Skip logic: a (N, CONTRACT) pair is skipped if it is already present in the
 * file, so a crashed run can be resumed without re-running completed scenarios.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CSV_HEADER = "N,CONTRACT,MEAN_BLOCKS,BLOCKS";

export interface CampaignBlockResult {
    campaignIndex: number;
    /** Block number of the FIRST tx fired by this campaign. */
    startBlock: number;
    /** Block number of the LAST confirmed tx of this campaign. */
    endBlock: number;
    /** endBlock − startBlock  */
    blocksUsed: number;
}

export interface ScenarioResult {
    n:          number;
    contract:   "PFC" | "PSC";
    meanBlocks: number;
    blocks:     number[];    // one entry per campaign
}

/** True if (n, contract) is already in the file (skippable). */
export function isAlreadyCompleted(
    filePath: string,
    n: number,
    contract: "PFC" | "PSC",
): boolean {
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    for (const line of lines.slice(1)) {           // skip header
        const parts = line.split(",");
        if (parts[0] === String(n) && parts[1] === contract) return true;
    }
    return false;
}

/** Create the file with the CSV header if it does not exist yet. */
export function ensureFile(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, CSV_HEADER + "\n");
    }
}

/** Serialize and append one scenario result. */
export function appendResult(filePath: string, result: ScenarioResult): void {
    const blocksJson = JSON.stringify(result.blocks);
    const line = `${result.n},${result.contract},${result.meanBlocks.toFixed(2)},"${blocksJson}"`;
    fs.appendFileSync(filePath, line + "\n");
}

/** Aggregate N campaign results into a ScenarioResult. */
export function computeResult(
    n:               number,
    contract:        "PFC" | "PSC",
    campaignResults: CampaignBlockResult[],
): ScenarioResult {
    const blocks     = campaignResults.map(r => r.blocksUsed);
    const meanBlocks = blocks.reduce((a, b) => a + b, 0) / blocks.length;
    return { n, contract, meanBlocks, blocks };
}
