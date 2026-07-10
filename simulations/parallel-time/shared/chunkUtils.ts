import { TOTAL_CHUNKS } from "./ParallelTimeConfig";

/**
 * Map a CID index to a deterministic chunk index (0–TOTAL_CHUNKS-1).
 * Same hash as the gas-simulation runner so gas measurements stay comparable.
 */
export function chunkForCid(cidIndex: number): number {
    return ((cidIndex * 7919) + 104729) % TOTAL_CHUNKS;
}

/**
 * Map a chunk index (0–99) to a GlobalPosition at the chunk centre.
 * 10 × 10 grid, each chunk spans 0.1° (= 1_000_000 in E7). Centre offset = 500_000.
 */
export function positionForChunk(chunkIndex: number) {
    const row = Math.floor(chunkIndex / 10);
    const col = chunkIndex % 10;
    return {
        latitudeInteger:  41,
        latitudeDecimal:  row * 1_000_000 + 500_000,
        longitudeInteger: 11,
        longitudeDecimal: col * 1_000_000 + 500_000,
    };
}
