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
import {ReadStream} from "fs";
import {ethers} from "hardhat";
import {generateScenarios} from "../shared/SimulationConfig";
import {CSV_HEADER, RAW_CSV_HEADER} from "../shared/GasTracker";
import {ScenarioRunner} from "./ScenarioRunner";


const OUTPUT_FILE = "results/gas_simulation_results.csv";
const RAW_OUTPUT_FILE = "results/gas_simulation_results_raw.csv";

function getCompletedScenarios(filePath: string): Set<string> {
    const completed = new Set<string>();
    if (!fs.existsSync(filePath)) return completed;

    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
        if (line.startsWith("senders")) continue; // header
        const [s, v] = line.split(",");
        if (s && v) completed.add(`${s},${v}`);
    }
    return completed;
}


async function main() {
    const scenarios = generateScenarios();

    console.log(`=== Gas Consumption Simulation ===`);
    console.log(`Scenarios: ${scenarios.length}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);
    const completed = getCompletedScenarios(OUTPUT_FILE);

    for (let i = 0; i < scenarios.length; i++) {
        const {senders, verifiers} = scenarios[i];
        if (!fs.existsSync(OUTPUT_FILE)) {
            fs.writeFileSync(OUTPUT_FILE, CSV_HEADER + "\n");
        }
        if (!fs.existsSync(RAW_OUTPUT_FILE)) {
            fs.writeFileSync(RAW_OUTPUT_FILE, RAW_CSV_HEADER + "\n");
        }
        if (completed.has(`${senders},${verifiers}`)) {
            console.log(`  Skipping ${senders}S × ${verifiers}V (already done)`);
            continue;
        }
        console.log(`\n[${ i + 1}/${scenarios.length}] Scenario: ${senders}S × ${verifiers}V`);
        console.log("─".repeat(50));

        const runner = new ScenarioRunner(senders, verifiers);
        const rawStream = fs.createWriteStream(RAW_OUTPUT_FILE, {flags: 'a'})
        runner.setRawStream(rawStream);
        const csvRows = await runner.run();
        fs.appendFileSync(OUTPUT_FILE, csvRows.join("\n") + "\n");
        rawStream.end()

        // Reset Hardhat state between scenarios to free memory
        await ethers.provider.send("hardhat_reset", []);
        break;
    }

    console.log(`\n=== Simulation complete ===`);
    console.log(`Results: ${OUTPUT_FILE}`);
}

main().catch((err) => {
    console.error("Simulation failed:", err);
    process.exit(1);
});