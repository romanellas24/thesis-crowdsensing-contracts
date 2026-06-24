/**
 * Configuration for the parallel-time simulation.
 *
 * Block gas limits (post-Fusaka, December 2025):
 *   - Block gas limit:        60_000_000  (EIP-7935, now the mainnet default)
 *   - Per-transaction cap:    2^24 ≈ 16_777_216  (EIP-7825)
 *
 * The simulation uses BLOCK_GAS_LIMIT to configure Hardhat's mining so that
 * concurrent campaigns compete for block space. Individual txs are all well
 * below the per-tx cap, so no special handling is needed for EIP-7825.
 *
 * IMPORTANT — hardhat.config.ts must have, under networks.hardhat:
 *   blockGasLimit: 60_000_000
 *   mining: { auto: false, interval: MINING_INTERVAL_MS }
 *
 * Or set them at runtime via the env-var approach shown in run.ts.
 */

// Current Ethereum mainnet block gas limit (post-Fusaka / EIP-7935).
export const BLOCK_GAS_LIMIT = 60_000_000;

// How often Hardhat mines a block (ms). 200 ms gives campaigns enough time
// to enqueue multiple txs per block and show contention at 60 M gas/block.
export const MINING_INTERVAL_MS = 200;

// Number of concurrent campaigns to benchmark.
export const CAMPAIGN_SIZES = [1, 2, 4, 8, 16];

// Per-campaign actor counts and workload.
export const SENDERS_PER_CAMPAIGN    = 1_000;
export const VERIFIERS_PER_CAMPAIGN  = 100;
export const TOTAL_CIDS              = 5_000;
export const CHECKS_REQUIRED        = 3;
export const MAJORITY               = Math.floor(CHECKS_REQUIRED / 2) + 1; // 2
export const TOTAL_CHUNKS           = 100;   // 10 × 10 grid

// HD wallet index layout.
// Indices 0–19 are reserved for Hardhat's default signers (used as owners).
// Sender/verifier wallets start at WALLET_BASE_INDEX.
// Per-campaign stride: SENDERS_PER_CAMPAIGN + VERIFIERS_PER_CAMPAIGN = 1 100.
//   campaign i => indices [WALLET_BASE_INDEX + i*1100, …, +1099]
//   max index with 16 campaigns: WALLET_BASE_INDEX + 15*1100 + 1099 = 18 099
export const WALLET_BASE_INDEX     = 500;   // safe margin above signer range
export const WALLETS_PER_CAMPAIGN  = SENDERS_PER_CAMPAIGN + VERIFIERS_PER_CAMPAIGN;

export const HARDHAT_MNEMONIC =
    "test test test test test test test test test test test junk";

// PSC-specific novel parameters (mirrors the gas-simulation config).
export const PSC_NOVEL_PARAMS = {
    rewardDecayEnabled:          true,
    rewardDecayFactor:           2,
    kickVerifierAfterWrongVotes: 10_000,
    pardonWrongVoteAfterRightVotes: 5,
};
export const PSC_MAX_DATA_PER_CHUNK = 200;
