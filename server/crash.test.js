/**
 * RTP harness for crash.js — sanity check the math.
 *
 * Runs N=10,000 rounds, then for several fixed-target cash-out strategies
 * computes empirical RTP = (sum of payouts) / (sum of stakes).
 *
 * Expected: every strategy lands near 97% ± a couple of percent of noise.
 * Also prints the insta-crash rate (should be ~3%) and the median/mean crash point.
 */
import { newRoundCommitment, crashFromSeeds } from './crash.js';

const N = 10_000;
const TARGETS = [1.10, 1.50, 2.00, 3.00, 5.00, 10.00];

const crashPoints = [];
for (let nonce = 1; nonce <= N; nonce++) {
  const c = newRoundCommitment(nonce);
  crashPoints.push(c.crashPoint);

  // Cheap correctness check: a fresh recompute from the revealed seeds
  // must reproduce the same crash point. (Provably-fair guarantee.)
  const recomputed = crashFromSeeds(c.serverSeed, c.clientSeed, c.nonce);
  if (recomputed !== c.crashPoint) {
    throw new Error(`recompute mismatch on nonce ${nonce}: ${recomputed} vs ${c.crashPoint}`);
  }
}

// Distribution stats
const instaCrashes = crashPoints.filter((p) => p === 1.00).length;
const sorted = [...crashPoints].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const mean = crashPoints.reduce((s, p) => s + p, 0) / crashPoints.length;
const max = sorted[sorted.length - 1];

console.log(`\nEagle Crash — RTP harness (${N.toLocaleString()} rounds)`);
console.log('─'.repeat(54));
console.log(`Floors at 1.00x:      ${(instaCrashes / N * 100).toFixed(2)}%   (~3-4% expected from the formula)`);
console.log(`Median crash point:   ${median.toFixed(2)}x`);
console.log(`Mean crash point:     ${mean.toFixed(2)}x`);
console.log(`Max crash point:      ${max.toFixed(2)}x`);
console.log('─'.repeat(54));

// RTP per cash-out target.
// Strategy: bet 1 unit every round, auto-cash-out at target T.
//   win  → returns T units (net +T-1)
//   bust → returns 0      (net -1)
// RTP = total returned / total wagered.
console.log('Target      Wins         RTP');
for (const target of TARGETS) {
  let wagered = 0;
  let returned = 0;
  for (const cp of crashPoints) {
    wagered += 1;
    // Win iff the crash point is strictly above the cash-out target.
    // (At equality, the round ended exactly at T — treat as lose to be conservative.)
    if (cp > target) returned += target;
  }
  const rtp = (returned / wagered) * 100;
  const wins = crashPoints.filter((cp) => cp > target).length;
  console.log(
    `${target.toFixed(2)}x      ${String(wins).padStart(5)}/${N}   ${rtp.toFixed(2)}%`
  );
}
console.log('─'.repeat(54));
console.log('Target RTP: 97.00%. Empirical should land within a couple % of that.\n');
