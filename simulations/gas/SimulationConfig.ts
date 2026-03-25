/**
 * Simulation configuration.
 *
 * Why checksRequired=3: majority=2, keeps verification rounds per CID at 2.
 * Why cooldown=0: allows a single verifier to re-verify the same CID slot
 *   (necessary for the 1-verifier scenario).
 * Why dataNeeded=0 + minimumParticipants=0: prevents auto-close during bulk
 *   submission/verification (_checkCampaignCompletion third guard fails).
 * Why maxDataPerSender/maxDataPerVerifierPerBond are scenario-dependent:
 *   _rewardSender always deducts from _senderSupplyBond, so bonds must exist.
 *   verifier bondBalance only decreases (rewards go to wallet, not bondBalance).
 */

export const SENDERS = [1, 10, 100, 1000, 10000];
export const VERIFIERS = [2, 10, 100, 1000, 10000];
export const TOTAL_CIDS = 10_000;
export const TOTAL_CHUNKS = 100;   // 10x10 grid
export const CHECKS_REQUIRED = 3;  // odd, majority = 2
export const MAJORITY = Math.floor(CHECKS_REQUIRED / 2) + 1; // = 2

export interface SimulationScenario {
    senders: number;
    verifiers: number;
}

export function generateScenarios(): SimulationScenario[] {
    const scenarios: SimulationScenario[] = [];
    for (const s of SENDERS) {
        for (const v of VERIFIERS) {
            scenarios.push({senders: s, verifiers: v});
        }
    }
    return scenarios;
}

/**
 * Build a scenario-specific contract config.
 *
 * maxDataPerSender scales with CIDs-per-sender so bond deposits stay minimal.
 * maxDataPerVerifierPerBond covers all checks a single verifier might perform.
 */
export function buildContractConfig(senders: number, verifiers: number) {
    const maxDataPerSender = Math.ceil(TOTAL_CIDS / senders);
    // Each CID needs MAJORITY checks. Total checks = TOTAL_CIDS * MAJORITY.
    // Worst-case single verifier handles all of them.
    const maxDataPerVerifierPerBond = Math.ceil((TOTAL_CIDS * MAJORITY) / verifiers);

    return {
        needs: {
            freshnessPeriod: 3600,
            dataNeeded: 0,
            minimumParticipants: 0,
            checksRequired: CHECKS_REQUIRED,
            verifierCooldown: 1,
            verificationTimeout: 86400,
            maxDataPerSender,
            maxDataPerVerifierPerBond,
            maximumDataPerChunk: 0,
        },
        rewardConfig: {
            totalDst: 10_000_000,
            dataSenderPayout: 10,
            dataVerifierPayout: 5,
            dataSenderBondPerData: 1,
            dataVerifierBondPerData: 1,
        },
        originCoordinates: {
            latitudeInteger: 41,
            latitudeDecimal: 0,
            longitudeInteger: 11,
            longitudeDecimal: 0,
        },
        chunkConfig: {
            chunkSize: 1000000,  // 0.1 DEG per chunk
            chunk4Side: 10,      // 10×10 = 100 chunks
        },
    };
}

/**
 * Map a chunk index (0–99) to a GlobalPosition at the chunk center.
 *
 * Grid layout: row = floor(index/10), col = index%10
 * Each chunk spans 0.1 DEG (1_000_000 in E7). Center offset = 500_000.
 */
export function positionForChunk(chunkIndex: number) {
    const row = Math.floor(chunkIndex / 10);
    const col = chunkIndex % 10;
    return {
        latitudeInteger: 41,
        latitudeDecimal: row * 1_000_000 + 500_000,
        longitudeInteger: 11,
        longitudeDecimal: col * 1_000_000 + 500_000,
    };
}

export function chunkForCid(cidIndex: number): number {
    return ((cidIndex * 7919) + 104729) % TOTAL_CHUNKS;
}