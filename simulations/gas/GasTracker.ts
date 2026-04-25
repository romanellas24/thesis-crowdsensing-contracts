/**
 * Collects per-operation gas measurements and produces aggregated CSV rows.
 *
 * Each record stores individual gas values so we can compute:
 *   - first-call gas (storage initialization cost)
 *   - average subsequent-call gas
 *   - min / max / total
 *
 */
import * as fs from "node:fs";

interface RawRecord {
    operation: string;
    callIndex: number;
    gas: bigint;
    role: "owner" | "sender" | "verifier";
    roleIndex: number;
}

export class GasTracker {

    private records: Map<string, bigint[]> = new Map();

    private ownerGasTotal = 0n;
    private senderGas: Map<number, {gas: bigint, dataSent: number}> = new Map();
    private verifierGas: Map<number, {gas: bigint, checksSubmitted: number}> = new Map();

    private callCounters: Map<string, number> = new Map();

    private rawStream: fs.WriteStream | null = null;

    setRawStream(stream: fs.WriteStream): void {
        this.rawStream = stream;
    }

    private rawPrefix = "";

    setRawPrefix(senders: number, verifiers: number): void {
        this.rawPrefix = `${senders},${verifiers},`;
    }

    record(operation: string, gas: bigint, role: "owner" | "sender" | "verifier", roleIndex = 0): void {
        const callIndex = this.callCounters.get(operation) ?? 0;
        this.callCounters.set(operation, callIndex + 1);
        if (this.rawStream) {
            this.rawStream.write(`${this.rawPrefix}${operation},${callIndex},${gas},${role},${roleIndex}\n`);
        }

        if (!this.records.has(operation)) {
            this.records.set(operation, []);
        }
        this.records.get(operation)!.push(gas);

        // Role tracking
        if (role === "owner") {
            this.ownerGasTotal += gas;
            return;
        }
        if (role === "sender") {
            if (!this.senderGas.has(roleIndex)) {
                this.senderGas.set(roleIndex, {gas: 0n, dataSent: 0});
            }
            this.senderGas.get(roleIndex)!.gas += gas;
        } else if(role === "verifier") {
            if (!this.verifierGas.has(roleIndex)) {
                this.verifierGas.set(roleIndex, {gas: 0n, checksSubmitted: 0});
            }
            this.verifierGas.get(roleIndex)!.gas += gas;
        }

        if(operation === "data_submission")
            this.recordDataSent(roleIndex);

        if(operation === "verification_submit")
            this.recordCheckSubmitted(roleIndex);

    }

    getAggregates(): OperationAggregate[] {
        const result: OperationAggregate[] = [];
        for (const [operation, values] of this.records) {
            const count = values.length;
            const firstCall = values[0];
            const total = values.reduce((a, b) => a + b, 0n);
            const min = values.reduce((a, b) => a < b ? a : b);
            const max = values.reduce((a, b) => a > b ? a : b);
            const avgSubsequent = count > 1
                ? (total - firstCall) / BigInt(count - 1)
                : 0n;
            result.push({operation, count, firstCall, avgSubsequent, min, max, total});
        }
        return result;
    }

    toCsvRows(senders: number, verifiers: number): string[] {
        const rows = this.getAggregates().map(a =>
            [senders, verifiers, a.operation, a.count, a.firstCall, a.avgSubsequent, a.min, a.max, a.total, ""].join(",")
        );
        rows.push(...this.getRoleSummaryRows(senders, verifiers));
        rows.push(...this.getPerWalletRows(senders, verifiers));
        return rows;
    }

    /** Resets all recorded data. */
    clear(): void {
        this.records.clear();
        this.ownerGasTotal = 0n;
        this.senderGas.clear();
        this.verifierGas.clear();

        this.callCounters.clear();
    }

    recordDataSent(senderIndex: number): void {
        try {
            this.senderGas.get(senderIndex)!.dataSent++;
        } catch (e) {}

    }

    recordCheckSubmitted(verifierIndex: number): void {
        try {
            this.verifierGas.get(verifierIndex)!.checksSubmitted++;
        } catch (e) {}
    }

    getRoleSummaryRows(senders: number, verifiers: number): string[] {
        const senderTotal = [...this.senderGas.values()].reduce((a, b) => a + b.gas, 0n);
        const verifierTotal = [...this.verifierGas.values()].reduce((a, b) => a + b.gas, 0n);
        const senderAvg = senders > 0 ? senderTotal / BigInt(senders) : 0n;
        const verifierAvg = verifiers > 0 ? verifierTotal / BigInt(verifiers) : 0n;

        return [
            [senders, verifiers, "ROLE_TOTAL_owner", 1, this.ownerGasTotal, this.ownerGasTotal, this.ownerGasTotal, this.ownerGasTotal, this.ownerGasTotal, ""].join(","),
            [senders, verifiers, "ROLE_TOTAL_sender", senders, senderTotal, senderAvg, 0, 0, senderTotal, ""].join(","),
            [senders, verifiers, "ROLE_TOTAL_verifier", verifiers, verifierTotal, verifierAvg, 0, 0, verifierTotal, ""].join(","),
        ];
    }

    getPerWalletRows(senders: number, verifiers: number): string[] {
        const senderArray = [...this.senderGas.entries()]
            .map(([idx, v]) => `${idx}:${v.gas}:${v.dataSent}`).join("|");
        const verifierArray = [...this.verifierGas.entries()]
            .map(([idx, v]) => `${idx}:${v.gas}:${v.checksSubmitted}`).join("|");

        return [
            [senders, verifiers, "PER_WALLET_sender", senders, 0, 0, 0, 0, 0, senderArray].join(","),
            [senders, verifiers, "PER_WALLET_verifier", verifiers, 0, 0, 0, 0, 0, verifierArray].join(","),
        ];
    }



}

export interface OperationAggregate {
    operation: string;
    count: number;
    firstCall: bigint;
    avgSubsequent: bigint;
    min: bigint;
    max: bigint;
    total: bigint;
}

export const CSV_HEADER =
    "senders,verifiers,operation,count,first_call_gas,avg_subsequent_gas,min_gas,max_gas,total_gas,per_wallet_detail";

export const RAW_CSV_HEADER =
    "senders,verifiers,operation,call_index,gas,role,role_index";