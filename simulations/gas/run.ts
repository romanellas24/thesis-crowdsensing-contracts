/**
 * Gas consumption simulation.
 *
 * Runs all 25 combinations of (senders * verifiers) and records per-operation
 * gas consumption to a CSV file. Results are saved incrementally so partial
 * data survives crashes.
 *
 * Run:
 *   npx hardhat run simulation/run.ts
 *
 * Output:
 *   simulation_results.csv
 *
 * This script can take a lot of time to execute.
 */

import * as fs from "fs";
import {ethers} from "hardhat";
import {generateScenarios} from "./SimulationConfig";
import {CSV_HEADER, RAW_CSV_HEADER} from "./GasTracker";
import {ScenarioRunner} from "./ScenarioRunner";

const OUTPUT_FILE = "results/gas_simulation_results.csv";
const RAW_OUTPUT_FILE = "results/gas_simulation_results_raw.csv";


async function main() {
    const scenarios = generateScenarios();
    const rows: string[] = [CSV_HEADER];
    const rawRows: string[] = [RAW_CSV_HEADER];

    console.log(`=== Gas Consumption Simulation ===`);
    console.log(`Scenarios: ${scenarios.length}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    for (let i = 0; i < scenarios.length; i++) {
        const {senders, verifiers} = scenarios[i];
        console.log(`\n[${ i + 1}/${scenarios.length}] Scenario: ${senders}S × ${verifiers}V`);
        console.log("─".repeat(50));

        const runner = new ScenarioRunner(senders, verifiers);
        const csvRows = await runner.run();
        rows.push(...csvRows);
        rawRows.push(...runner.getRawRows(senders, verifiers));
        fs.writeFileSync(RAW_OUTPUT_FILE, rawRows.join("\n") + "\n");

        // Incremental save
        fs.writeFileSync(OUTPUT_FILE, rows.join("\n") + "\n");
        console.log(`Saved ${rows.length - 1} total data rows to ${OUTPUT_FILE}`);

        // Reset Hardhat state between scenarios to free memory
        await ethers.provider.send("hardhat_reset", []);
    }

    console.log(`\n=== Simulation complete ===`);
    console.log(`Total data rows: ${rows.length - 1}`);
    console.log(`Results: ${OUTPUT_FILE}`);
}

main().catch((err) => {
    console.error("Simulation failed:", err);
    process.exit(1);
});