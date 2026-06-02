import {MAX_DST} from "../../../testUtils/constants";


/**
 * Compact campaign config for E2E tests.
 *  - checksRequired = 2  (so 2 verifiers are enough for consensus)
 *  - verifierCooldown = 0 (a verifier can verify back-to-back)
 *  - verificationTimeout = 3600 (no time pressure during tests)
 */
export const testConfig = {
    needs: {
        dataNeeded: 5,
        checksRequired: 3,
        verifierCooldown: 1,
        verificationTimeout: 3600,
        minimumParticipants: 1,
        maxDataPerSender: 5,
        maxDataPerVerifierPerBond: 5,
        maximumDataPerChunk: 10,
    },
    chunkConfig: { chunkSize: 1_000_000, chunk4Side: 5 },
    rewardConfig: {
        totalDst: MAX_DST,
        dataSenderPayout: 100,
        dataVerifierPayout: 30,
        dataSenderBondPerData: 1,
        dataVerifierBondPerData: 1,
    },
    originCoordinates: {
        latitudeInteger: 41, latitudeDecimal: 1_000_000,
        longitudeInteger: 11, longitudeDecimal: 1_000_000,
    },
};

/** Decay disabled by default; tests that need decay flip the flag locally. */
export const novelParams = {
    rewardDecayEnabled: false,
    rewardDecayFactor: 1,
    pardonWrongVoteAfterRightVotes: 3,
    kickVerifierAfterWrongVotes: 10,
};

export const validPosition = {
    latitudeInteger: 41, latitudeDecimal: 1_500_000,
    longitudeInteger: 11, longitudeDecimal: 1_500_000,
};

export const validPosition2 = {
    latitudeInteger: 41, latitudeDecimal: 1_600_000,
    longitudeInteger: 11, longitudeDecimal: 1_600_000,
};

/** Per-participant DST allowance for bond payments in tests. */
export const BOND_DST = 100n;
