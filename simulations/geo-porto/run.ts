/**
 * Geographic Simulation - Porto Taxi Dataset on PSC (fault-tolerant variant)
 *
 * Evaluates the PSC contract's spatial chunking with real-world GPS traces AND
 * its tolerance to verifier failures. Active novel features:
 *   §2.6.1 trusted verifier  (Kdec delivered per-election inside bundle)
 *   §2.6.2 reward decay      (dataSenderPayout · f(chunkLoad))
 *
 * What changed vs. the previous run:
 *   The old driver relied on VerifierPrivacyFirst.startVerifyLoop(), whose
 *   "no data available" path suspends on an event notifier that only wakes on a
 *   NEW DataVerificationRequestedEvent. A verifier that dies after being elected
 *   leaves a slot that becomes reclaimable purely by deadline expiry - a TEMPORAL
 *   trigger that emits no event. So the surviving verifiers slept forever and the
 *   drain loop never terminated. On a local Hardhat node block.timestamp does not
 *   advance on its own either, so the on-chain timeout never fired.
 *
 *   This run drives the survivors explicitly. When a full round makes no progress
 *   while data is still pending, it advances the EVM clock past verificationTimeout
 *   so the abandoned slots expire on-chain; the survivors then re-request, get
 *   re-elected onto those slots, the Owner re-delivers a fresh bundle (PSC resets
 *   _bundleDelivered on re-election), and the verification completes. No CID is lost.
 *
 *   The on-chain recovery logic (slot reassignment in _findAvailableSlot, bundle
 *   re-delivery on re-election) was already present and is left untouched; only the
 *   off-chain orchestration is reworked.
 *
 *   Failure under test: VERIFIER death. The Owner is assumed live (it is the party
 *   that re-delivers bundles).
 *
 * Input:
 *   500 rows from the Taxi Service Prediction dataset (Porto, Kaggle).
 *   Prepare: head -501 train.csv > simulations/geo-porto/porto_500.csv
 *
 * Outputs:
 *   results/geo/geo_porto_<n>_k<k>.json        - chunk CID distribution + recovery stats.
 *   results/geo/geo_porto_<n>_k<k>_decay.json  - expected sender reward for the NEXT CID.
 *
 * Usage:
 *   npx hardhat run simulations/geo-porto/run.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {ethers} from 'hardhat';

import cipher from '../../testUtils/cipher';
import {OwnerPrivacySecond} from '../../src/sdk/PSC/OwnerPrivacySecond';
import {SenderPrivacySecond} from '../../src/sdk/PSC/SenderPrivacySecond';
import {VerifierPrivacySecond} from '../../src/sdk/PSC/VerifierPrivacySecond';
import {VerificationResult} from '../../src/sdk/utils/CipherProvider';

//  Configuration

const NO_SENDERS = 500;
const DECAY_FACTOR = 1;

const CSV_PATH = `simulations/geo-porto/porto_${NO_SENDERS}.csv`;
const OUT_MAIN = `results/geo/geo_porto_${NO_SENDERS}_k${DECAY_FACTOR}.json`;
const OUT_DECAY = `results/geo/geo_porto_${NO_SENDERS}_k${DECAY_FACTOR}_decay.json`;

const CHUNK4_SIDE = 10;   // 10×10 grid => 100 chunks
const NUM_VERIFIERS = 10;
const MAX_PER_SENDER = 100;   // GPS points per trip
const CHECKS = 3;    // verifications required per CID

// Fault injection (the point of this run).
//
// The first NUM_FAULTY_VERIFIERS verifiers get elected once - a real on-chain
// slot, a real bundle delivered to them - then go permanently silent (they never
// submit). Sequential election concentrates them on the earliest pending datum,
// so with NUM_FAULTY_VERIFIERS == CHECKS all three slots of one CID die together:
// majority can never be reached on it, which forces the timeout-based recovery
// path. Must satisfy: (NUM_VERIFIERS - NUM_FAULTY_VERIFIERS) >= CHECKS, otherwise
// too few survivors remain to ever close a recovered CID.
const NUM_FAULTY_VERIFIERS = 3;

// Reward parameters (§2.6.2)
const SENDER_PAYOUT = 1000; // DST per valid CID
const VERIFIER_PAYOUT = 50;   // DST per correct vote

const MNEMONIC = 'test test test test test test test test test test test junk';
const WALLET_BASE = 500;
const POLL_INTERVAL_MS = 50;

// Verification timeout (seconds, on-chain). Kept at the experiment's value; the
// driver advances the EVM clock by this + 1 to expire abandoned slots.
const VERIFICATION_TIMEOUT = 120;

// Safety bound: how many consecutive zero-progress timeout advances we tolerate
// before declaring the campaign unrecoverable (should be impossible with enough
// survivors). Guards against an infinite churn loop.
const MAX_CONSECUTIVE_STALLS = 5;

//  Types

interface GpsPoint {
    lat: number;
    lon: number;
}

//  SerializedOwner
//
// PSC introduces two extra owner-side tx types that can fire concurrently:
//   - notifyVerificationKeyReady(dataId)           (one per submitted CID)
//   - deliverVerificationBundle(dataId, v, bundle) (one per verifier election)
//
// With parallel data submission and many concurrent verifier requests, multiple
// events can arrive in the same ethers poll cycle, causing the owner to submit
// several txs simultaneously => nonce conflicts. This matters more here: every
// recovered slot triggers an extra re-election => an extra bundle delivery.
//
// Fix: a single async queue drains every outgoing owner tx in FIFO order.
// All four handler overrides route through it.

async function parsePorto(csvPath: string): Promise<GpsPoint[][]> {
    if (!fs.existsSync(csvPath))
        throw new Error(`CSV not found: ${csvPath}\n  head -501 train.csv > ${csvPath}`);

    const rows: GpsPoint[][] = [];
    const stream = readline.createInterface({input: fs.createReadStream(csvPath)});
    let header = true;

    for await (const line of stream) {
        if (header) {
            header = false;
            continue;
        }
        if (!line.trim()) continue;

        // Locate MISSING_DATA (field index 7) without a full CSV split.
        let cc = 0, quoted = false, ms = -1, me = -1;
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '"') {
                quoted = !quoted;
                continue;
            }
            if (line[i] === ',' && !quoted) {
                cc++;
                if (cc === 7) ms = i + 1;
                if (cc === 8) {
                    me = i;
                    break;
                }
            }
        }
        if (ms === -1 || me === -1) continue;
        if (line.slice(ms, me).includes('True')) continue;

        // Extract POLYLINE - last field, JSON [[lon,lat], ...].
        const ps = line.indexOf('[['), pe = line.lastIndexOf(']]');
        if (ps === -1 || pe === -1) continue;

        let poly: [number, number][];
        try {
            poly = JSON.parse(line.slice(ps, pe + 2));
        } catch {
            continue;
        }
        if (poly.length === 0) continue;

        // Dataset stores [longitude, latitude] - swap to {lat, lon}.
        rows.push(poly.slice(0, MAX_PER_SENDER).map(([lon, lat]) => ({lat, lon})));
    }
    return rows;
}

//  Coordinate utilities  (unchanged)

function splitDeg(deg: number) {
    const sign = deg >= 0 ? 1 : -1, abs = Math.abs(deg);
    const intAbs = Math.floor(abs), decAbs = Math.round((abs - intAbs) * 10_000_000);
    return {intPart: sign * intAbs, decPart: (sign < 0 && intAbs === 0) ? -decAbs : decAbs};
}

function floatToGlobalPosition(lat: number, lon: number) {
    const {intPart: latI, decPart: latD} = splitDeg(lat);
    const {intPart: lonI, decPart: lonD} = splitDeg(lon);
    return {
        latitudeInteger: latI, latitudeDecimal: latD,
        longitudeInteger: lonI, longitudeDecimal: lonD
    };
}

function e7ToGlobalPosition(latE7: number, lonE7: number) {
    const fromE7 = (e7: number) => {
        const sign = e7 >= 0 ? 1 : -1, abs = Math.abs(e7);
        const intAbs = Math.floor(abs / 10_000_000), decAbs = abs % 10_000_000;
        return {intPart: sign * intAbs, decPart: (sign < 0 && intAbs === 0) ? -decAbs : decAbs};
    };
    const lat = fromE7(latE7), lon = fromE7(lonE7);
    return {
        latitudeInteger: lat.intPart, latitudeDecimal: lat.decPart,
        longitudeInteger: lon.intPart, longitudeDecimal: lon.decPart
    };
}

//  Bounding box  (unchanged)
function computeBbox(rows: GpsPoint[][]) {
    const pts = rows.flat();
    const MARGIN = 10_000;
    const minLat = Math.min(...pts.map(p => p.lat)), maxLat = Math.max(...pts.map(p => p.lat));
    const minLon = Math.min(...pts.map(p => p.lon)), maxLon = Math.max(...pts.map(p => p.lon));

    const originLat = Math.floor(minLat * 10_000_000) - MARGIN;
    const originLon = Math.floor(minLon * 10_000_000) - MARGIN;
    const spanLat = Math.ceil(maxLat * 10_000_000) - Math.floor(minLat * 10_000_000);
    const spanLon = Math.ceil(maxLon * 10_000_000) - Math.floor(minLon * 10_000_000);
    const side = Math.max(spanLat, spanLon) + 2 * MARGIN;
    const chunkSize = Math.ceil(side / CHUNK4_SIDE);

    return {originLat, originLon, side, chunkSize, minLat, maxLat, minLon, maxLon};
}

// Replicates _getChunkIndex to count CIDs per chunk before deployment.
function precomputeChunks(rows: GpsPoint[][], originLat: number, originLon: number, chunkSize: number) {
    const counts: Record<number, number> = {};
    for (const pts of rows) {
        for (const {lat, lon} of pts) {
            const row = Math.floor((Math.round(lat * 10_000_000) - originLat) / chunkSize);
            const col = Math.floor((Math.round(lon * 10_000_000) - originLon) / chunkSize);
            const idx = row * CHUNK4_SIDE + col;
            counts[idx] = (counts[idx] ?? 0) + 1;
        }
    }
    return {counts, maxCount: Math.max(...Object.values(counts))};
}

//  Config builders  (unchanged interface)
function buildConfig(bbox: ReturnType<typeof computeBbox>, totalCids: number, maximumDataPerChunk: number) {
    const maxDataPerVerifierPerBond = Math.ceil((totalCids * CHECKS) / NUM_VERIFIERS) * totalCids;
    // totalDst covers the MAXIMUM possible payout (pre-decay). Excess stays locked.
    const totalDst = BigInt(totalCids * SENDER_PAYOUT + totalCids * CHECKS * VERIFIER_PAYOUT);

    return {
        needs: {
            dataNeeded: 0, minimumParticipants: 0,
            checksRequired: CHECKS,
            verifierCooldown: 1,
            verificationTimeout: VERIFICATION_TIMEOUT,
            maxDataPerSender: MAX_PER_SENDER,
            maxDataPerVerifierPerBond,
            maximumDataPerChunk,     // non-zero => reward decay active (§2.6.2)
        },
        rewardConfig: {
            totalDst,
            dataSenderPayout: SENDER_PAYOUT,
            dataVerifierPayout: VERIFIER_PAYOUT,
            dataSenderBondPerData: 1,
            dataVerifierBondPerData: 1,
        },
        originCoordinates: e7ToGlobalPosition(bbox.originLat, bbox.originLon),
        chunkConfig: {chunkSize: BigInt(bbox.chunkSize), chunk4Side: CHUNK4_SIDE},
    };
}

const novelParams = {
    rewardDecayEnabled: true,
    rewardDecayFactor: DECAY_FACTOR,
    kickVerifierAfterWrongVotes: 0,  // disabled - all (honest) votes are SUCCESS
    pardonWrongVoteAfterRightVotes: 0,
};

//  EVM clock helper
//
// Advances the local node past the slot timeout so abandoned slots become
// reclaimable on-chain. Wall-clock time on a Hardhat node is not representative
// of mainnet, so we drive the clock explicitly instead of waiting.
async function advancePastTimeout(provider: any): Promise<void> {
    await provider.send('evm_increaseTime', [VERIFICATION_TIMEOUT + 1]);
    await provider.send('evm_mine', []);
}

//  Main
async function main() {

    console.log('Geo Simulation - Porto / PSC');

    //  Phase 1: parse
    console.log(`▶ Parsing ${CSV_PATH}`);
    const rows = await parsePorto(CSV_PATH);
    if (rows.length === 0) throw new Error('No valid rows found.');

    const NUM_SENDERS = rows.length;
    const totalCids = rows.reduce((s, r) => s + r.length, 0);
    console.log(`  ${NUM_SENDERS} senders, ${totalCids} CIDs`);

    if (NUM_VERIFIERS - NUM_FAULTY_VERIFIERS < CHECKS)
        throw new Error(
            `Need at least CHECKS (${CHECKS}) survivors, have ` +
            `${NUM_VERIFIERS - NUM_FAULTY_VERIFIERS}. Lower NUM_FAULTY_VERIFIERS or raise NUM_VERIFIERS.`,
        );

    //  Phase 2: bounding box
    const bbox = computeBbox(rows);
    console.log('\n▶ Map bounding box');
    console.log(`  Lat: ${bbox.minLat.toFixed(6)} => ${bbox.maxLat.toFixed(6)}`);
    console.log(`  Lon: ${bbox.minLon.toFixed(6)} => ${bbox.maxLon.toFixed(6)}`);
    console.log(`  chunkSize: ${bbox.chunkSize} E7  (~${(bbox.chunkSize / 1e7 * 111_000).toFixed(0)} m lat)`);

    //  Phase 3: pre-compute chunk distribution

    const {counts: preChunkCounts, maxCount} =
        precomputeChunks(rows, bbox.originLat, bbox.originLon, bbox.chunkSize);

    const maximumDataPerChunk = 5_000;
    console.log(`\n▶ Chunk pre-distribution`);
    console.log(`  Chunks hit: ${Object.keys(preChunkCounts).length} / ${CHUNK4_SIDE * CHUNK4_SIDE}`);
    console.log(`  Max in one chunk: ${maxCount}  =>  maximumDataPerChunk: ${maximumDataPerChunk}`);

    //  Phase 4: deploy
    const config = buildConfig(bbox, totalCids, maximumDataPerChunk);
    const [ownerSgn] = await ethers.getSigners();
    const ownerKeys = cipher.generateKeyPair();

    console.log('\n▶ Deploying contracts');
    const dstToken = await (await ethers.getContractFactory('DataSentTokenContract'))
        .connect(ownerSgn).deploy(100_000_000_000n);
    await dstToken.waitForDeployment();

    const psc = await (await ethers.getContractFactory('PrivacySecondContract'))
        .connect(ownerSgn)
        .deploy(ownerKeys.publicKey, config, await dstToken.getAddress(), novelParams);
    await psc.waitForDeployment();
    console.log(`  PSC: ${await psc.getAddress()}`);

    //  Phase 5: wallets + DST funding
    const provider = ethers.provider;
    (provider as any).pollingInterval = POLL_INTERVAL_MS;

    const hd = ethers.HDNodeWallet.fromPhrase(MNEMONIC, '', "m/44'/60'/0'/0");
    const senderAddresses = Array.from({length: NUM_SENDERS},
        (_, i) => hd.deriveChild(WALLET_BASE + i).address);
    const verifierAddresses = Array.from({length: NUM_VERIFIERS},
        (_, i) => hd.deriveChild(WALLET_BASE + NUM_SENDERS + i).address);

    console.log('\n▶ Funding wallets');
    const eth100 = '0x' + (10n ** 20n).toString(16);
    for (const addr of [...senderAddresses, ...verifierAddresses]) {
        await provider.send('hardhat_setBalance', [addr, eth100]);
        await provider.send('hardhat_impersonateAccount', [addr]);
    }

    console.log('\n▶ Bonds');
    const senderBond = BigInt(MAX_PER_SENDER);
    const verifierBond = BigInt(config.needs.maxDataPerVerifierPerBond);
    let nonce = await ownerSgn.getNonce('pending');
    const dstTxs: Promise<any>[] = [];
    console.log('\n▶ Bonds - senders');
    for (const addr of senderAddresses) {
        const tx = await dstToken.connect(ownerSgn).transfer(addr, senderBond, {nonce: nonce++});
        dstTxs.push(tx.wait());
    }
    console.log('\n▶ Bonds - verifier');
    for (const addr of verifierAddresses) {
        const tx = await dstToken.connect(ownerSgn).transfer(addr, verifierBond, {nonce: nonce++});
        dstTxs.push(tx.wait());
    }
    await Promise.all(dstTxs);

    const senderWallets = await Promise.all(senderAddresses.map(a => ethers.getSigner(a)));
    const verifierWallets = await Promise.all(verifierAddresses.map(a => ethers.getSigner(a)));
    console.log(`  ${NUM_SENDERS + NUM_VERIFIERS} wallets funded`);

    //  Phase 6: SDK actors
    const ownerSDK = new OwnerPrivacySecond(ownerSgn, psc, dstToken, ownerKeys, cipher);
    const senders = senderWallets.map(w => new SenderPrivacySecond(w, psc, dstToken, cipher));
    const verifiers = verifierWallets.map(w =>
        new VerifierPrivacySecond(w, psc, dstToken, cipher,
            (_cid: string, _id: number) => VerificationResult.SUCCESS));

    await ownerSDK.setup(); // payInitialSupply + startListening

    //  Phase 7: sender enrollment (sequential)
    console.log(`\n▶ Enrolling ${NUM_SENDERS} senders`);
    const t1 = Date.now();
    for (let i = 0; i < senders.length; i++) {
        await senders[i].enroll();
        if ((i + 1) % 100 === 0 || i === senders.length - 1)
            console.log(`  ${i + 1} / ${NUM_SENDERS}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    }

    //  Phase 8: verifier enrollment (sequential)

    console.log(`\n▶ Enrolling ${NUM_VERIFIERS} verifiers`);
    for (const v of verifiers) await v.enroll();
    console.log('  Done');

    //  Phase 9: bonds

    console.log('\n▶ Paying bonds');
    await Promise.all([...senders.map(s => s.payBond()), ...verifiers.map(v => v.payBond())]);
    console.log('  Done');

    //  Phase 10: data submission
    //
    // Submit every CID first and wait until all are pending (one
    // DataVerificationRequestedEvent each, emitted by the Owner's
    // notifyVerificationKeyReady). Counting that event before any await follows
    // the usual "register the listener before sending" rule so we never miss an
    // emission that lands inside the same poll cycle.

    let pendingReady = 0;
    const onPending = () => {
        pendingReady++;
    };
    psc.on(psc.getEvent('DataVerificationRequestedEvent'), onPending);

    console.log(`\n▶ Submitting ${totalCids} CIDs`);
    const t2 = Date.now();
    await Promise.all(rows.map(async (pts, si) => {
        for (let pi = 0; pi < pts.length; pi++) {
            const tx = await senders[si].publishData(
                `GeoPoint_${si}_${pi}`,
                floatToGlobalPosition(pts[pi].lat, pts[pi].lon),
            );
            await tx.wait();
        }
    }));
    console.log(`  Submitted in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

    process.stdout.write('▶ Waiting for all CIDs to enter the pending queue');
    while (pendingReady < totalCids) {
        await new Promise(r => setTimeout(r, 200));
        process.stdout.write(`\r▶ Pending queue: ${pendingReady} / ${totalCids}   `);
    }
    console.log(`\r▶ Pending queue: ${totalCids} / ${totalCids}   `);

    //  Phase 12: resilient verification driver
    console.log('\n▶ Draining verification queue');
    let keepGoing = true;
    let count = 0;
    while (keepGoing) {
        try {
            const map = verifiers.map(async (v: VerifierPrivacySecond) => {
                return v.requestAndVerify();
            });
            const results = await Promise.all(map);
            for (const result of results) {
                if(result.dataId !== -1){
                    console.log(`Verified: ${count++}/${totalCids}`);
                } else {
                    keepGoing = false;
                }
            }
        } catch (e) {
            keepGoing = false;
        }
    }
    console.log('\n▶ DONE');

    // One survivor keeps verifying until no slot is currently available to it.
    /*
    const drainSurvivor = async (v: VerifierPrivacySecond) => {
        while (true) {
            const {result} = await v.requestAndVerify(true);
            if (result === VerificationResult.CANNOT_COMPLETE) return;
        }
    };

    const done = () => ownerSDK.getValidCount() + ownerSDK.getInvalidCount();
    const total = BigInt(totalCids);

    let prevDone = -1n;
    let consecutiveStalls = 0;
    let timeoutAdvances = 0;
    let recoveryRounds = 0;

    while (done() < total) {
        await Promise.all(verifiers.map(drainSurvivor));
        const completed = done();
        process.stdout.write(`\r  ${completed} / ${totalCids}   `);

        if (completed >= total) break;

        if (completed === prevDone) {
            // No survivor could make progress: the remaining work is time-locked
            // behind abandoned slots. Expire them and try again.
            await advancePastTimeout(provider);
            timeoutAdvances++;
            if (consecutiveStalls === 0) {
                await Promise.all(verifiers.map(drainSurvivor));
                recoveryRounds++;
            }
            consecutiveStalls++;
            if (consecutiveStalls > MAX_CONSECUTIVE_STALLS)
                throw new Error(
                    `Unrecoverable: ${total - completed} CIDs stuck after ` +
                    `${timeoutAdvances} timeout advances. Not enough live verifiers?`,
                );
        } else {
            consecutiveStalls = 0;
        }
        prevDone = completed;
    }

    const valid = ownerSDK.getValidCount(), invalid = ownerSDK.getInvalidCount();
    console.log(`\n  ${valid} valid, ${invalid} invalid`);
     */

    psc.off(psc.getEvent('DataVerificationRequestedEvent'), onPending);

    //  Phase 13: close

    await ownerSDK.closeCampaign();
    await ownerSDK.stopListening();

    //  Phase 14: chunk distribution  (unchanged)

    console.log('\n▶ Fetching campaign data');
    const [, , chunkIndices] = await psc.connect(ownerSgn).getCampaignData();
    const chunkDist: Record<number, number> = {};
    for (const idx of chunkIndices) {
        const n = Number(idx);
        chunkDist[n] = (chunkDist[n] ?? 0) + 1;
    }
    const covered = Object.keys(chunkDist).length;
    const totalChunks = CHUNK4_SIDE * CHUNK4_SIDE;

    //  Phase 15: expected decay rewards  (unchanged)

    console.log('▶ Querying getExpectedSenderReward for all chunks');
    const chunkRewards: Record<number, number> = {};
    for (let i = 0; i < totalChunks; i++)
        chunkRewards[i] = Number(await ownerSDK.getExpectedSenderReward(i));

    //  Phase 16: save

    const sharedConfigMeta = {
        dataSenderPayout: SENDER_PAYOUT,
        dataVerifierPayout: VERIFIER_PAYOUT,
        rewardDecayFactor: DECAY_FACTOR,
        chunk4Side: CHUNK4_SIDE,
        chunkSizeE7: bbox.chunkSize,
        originLatE7: bbox.originLat,
        originLonE7: bbox.originLon,
        squareSideE7: bbox.side,
        maximumDataPerChunk,
    };

    const mainOut = {
        timestamp: new Date().toISOString(),
        config: {
            senders: NUM_SENDERS, verifiers: NUM_VERIFIERS,
            faultyVerifiers: NUM_FAULTY_VERIFIERS,
            maxPerSender: MAX_PER_SENDER, checks: CHECKS,
            verificationTimeout: VERIFICATION_TIMEOUT,
            ...sharedConfigMeta,
        },
        results: {
            totalCids,
            coveredChunks: covered, totalChunks,
            coveragePercent: +(covered / totalChunks * 100).toFixed(1),
            chunkDistribution: chunkDist,
        },
    };

    const decayOut = {
        timestamp: new Date().toISOString(),
        description: `Expected DST for the next CID in each chunk after the simulation. ` +
            `Formula (§2.6.2): ${SENDER_PAYOUT} × ` +
            `((maxPerChunk − count) / maxPerChunk)^(1/${Math.pow(2, DECAY_FACTOR)})`,
        config: sharedConfigMeta,
        chunkExpectedRewards: chunkRewards,
    };

    for (const [fp, obj] of [[OUT_MAIN, mainOut], [OUT_DECAY, decayOut]] as const) {
        fs.mkdirSync(path.dirname(fp), {recursive: true});
        fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
    }

    //  Summary

    const decayedRewards = Object.values(chunkRewards).filter(r => r < SENDER_PAYOUT);
    const minReward = decayedRewards.length ? Math.min(...decayedRewards) : SENDER_PAYOUT;

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log(`║  Coverage    : ${covered}/${totalChunks} chunks (${mainOut.results.coveragePercent}%)`.padEnd(54) + '║');
    console.log(`║  Reward range: ${minReward} – ${SENDER_PAYOUT} DST`.padEnd(54) + '║');
    console.log(`║  => ${OUT_MAIN}`.padEnd(54) + '║');
    console.log(`║  => ${OUT_DECAY}`.padEnd(54) + '║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    return 0;
}

main().catch(err => {
    console.error('\n❌  Simulation failed:', err.message ?? err);
    process.exit(1);
}).then((res) => {
    if(res === 0)
        return;
});