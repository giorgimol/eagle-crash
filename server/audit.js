/**
 * Mathematical audit of Eagle Crash.
 *
 * Treats the game as a random variable X = crashPoint and verifies:
 *
 *   1. CLOSED-FORM RTP.  Derive P(win at target T) and RTP from the
 *      formula, compare to empirical at N = 100,000 rounds.
 *
 *   2. h IS UNIFORM ON [0, 1).  Kolmogorov-Smirnov test on the empirical
 *      CDF of h (the [0,1) value extracted from the HMAC).
 *
 *   3. INSTA-CRASH RATE.  P(X = 1.00) should be 0.03 exactly under
 *      h < 0.03, plus a few values where floor(97/(1-h)) ∈ [97, 99].
 *      Closed form: P(X = 1.00) = 0.03 + (3/100·something tiny).
 *
 *   4. CHI-SQUARED GOODNESS-OF-FIT.  Bucket the tail P(X > T) curve and
 *      check observed vs expected counts.
 *
 *   5. REPRODUCIBILITY.  Recompute crashFromSeeds on every round —
 *      verifies the provably-fair guarantee holds.
 *
 *   6. NUMERICAL EDGE CASES.  Verify behavior at h≈0 and h≈1-ε.
 */
import { newRoundCommitment, crashFromSeeds, RTP as RTP_CONST, sha256Hex } from './crash.js';
import { createHmac } from 'node:crypto';

const N = 100_000;
const TARGETS = [1.10, 1.50, 2.00, 3.00, 5.00, 10.00, 25.00, 50.00];

function pct(x) { return (x * 100).toFixed(3) + '%'; }
function pp(x, n=3) { return Number(x).toFixed(n); }

// ── Phase 1: Generate the sample ────────────────────────────────────
console.log(`\n┌──────────────────────────────────────────────────────────────┐`);
console.log(`│  EAGLE CRASH — MATHEMATICAL AUDIT                            │`);
console.log(`│  Sample size: N = ${N.toLocaleString().padStart(8)} rounds                       │`);
console.log(`│  Formula:  X = max(1.00, ⌊97 / (1 − h)⌋ / 100)               │`);
console.log(`│            where h = first 8 hex of HMAC-SHA256 / 2³²        │`);
console.log(`└──────────────────────────────────────────────────────────────┘`);

const crashPoints = new Array(N);
const hValues = new Array(N);
let reproMismatches = 0;
let hashMismatches = 0;

for (let nonce = 1; nonce <= N; nonce++) {
  const c = newRoundCommitment(nonce);
  crashPoints[nonce - 1] = c.crashPoint;

  // Recompute h from the published seeds — reproducibility check
  const recomputed = crashFromSeeds(c.serverSeed, c.clientSeed, c.nonce);
  if (recomputed !== c.crashPoint) reproMismatches++;

  // Hash commitment check
  const h = sha256Hex(c.serverSeed);
  if (h !== c.serverSeedHash) hashMismatches++;

  // Extract h for KS test (mirror the math in crash.js)
  const hmac = createHmac('sha256', c.serverSeed).update(`${c.clientSeed}:${c.nonce}`).digest('hex');
  const intVal = parseInt(hmac.slice(0, 8), 16);
  hValues[nonce - 1] = intVal / 0x100000000;
}

console.log(`\n── 1. PROVABLY-FAIR REPRODUCIBILITY ───────────────────────────────`);
console.log(`   Round-trip mismatches:   ${reproMismatches} / ${N}     ${reproMismatches === 0 ? '✓ PASS' : '✗ FAIL'}`);
console.log(`   sha256(serverSeed) check: ${hashMismatches} / ${N}      ${hashMismatches === 0 ? '✓ PASS' : '✗ FAIL'}`);

// ── 2. Empirical RTP per target ─────────────────────────────────────
console.log(`\n── 2. RTP — CLOSED FORM vs EMPIRICAL ──────────────────────────────`);
console.log(`   For target T = k/100 with k integer ≥ 101:`);
console.log(`      P(X ≥ T) = P(⌊97/(1−h)⌋ ≥ k) = P(h ≥ 1 − 97/k) = 97/k`);
console.log(`      RTP(T) = T · P(X ≥ T) = (k/100) · 97/k = 0.97   (exact)`);
console.log(`\n   Target  P_theo    P_emp     |  RTP_theo  RTP_emp   |  95% CI`);
console.log(`   ─────── ──────── ──────── ─────── ──────── ──────── ─────────────`);
for (const T of TARGETS) {
  const k = Math.round(T * 100);
  const Ptheo = 97 / k;
  const wins  = crashPoints.filter((cp) => cp >= T).length;
  const Pemp  = wins / N;
  const rtpTheo = T * Ptheo;
  const rtpEmp  = T * Pemp;
  // CI on RTP: σ²(RTP) = T² · P(1−P) / N
  const sigma = T * Math.sqrt(Pemp * (1 - Pemp) / N);
  const lo = rtpEmp - 1.96 * sigma;
  const hi = rtpEmp + 1.96 * sigma;
  console.log(`   ${pp(T, 2).padStart(5)}x  ${pp(Ptheo, 4)}   ${pp(Pemp, 4)}   |  ${pp(rtpTheo, 4)}    ${pp(rtpEmp, 4)}    |  [${pp(lo, 4)}, ${pp(hi, 4)}]`);
}

// ── 3. Insta-crash rate (X = 1.00) ──────────────────────────────────
// X = 1.00 iff max(1, ⌊97/(1-h)⌋/100) = 1.00, i.e. ⌊97/(1-h)⌋ ≤ 100.
//   ⌊97/(1-h)⌋ ≤ 100 ⟺ 97/(1-h) < 101 ⟺ h < 1 − 97/101 = 4/101
//   ⟹ P(X = 1.00) = 4/101 ≈ 0.03960
// Common mistake (mine!): claiming it's 3% by reading just the
// "97/(1-h)" piece. The CEILING boundary is 101, not 100.
console.log(`\n── 3. INSTA-CRASH RATE (X = 1.00) ─────────────────────────────────`);
const instaCrashes = crashPoints.filter((cp) => cp === 1.00).length;
const Pinsta = instaCrashes / N;
const Pinsta_theo = 4 / 101;
const sigmaInsta = Math.sqrt(Pinsta_theo * (1 - Pinsta_theo) / N);
console.log(`   Theoretical:  P(X = 1.00) = 4/101 = ${pp(Pinsta_theo, 5)}`);
console.log(`   Empirical:    ${pp(Pinsta, 5)}        (95% CI ± ${pp(1.96 * sigmaInsta, 5)})`);
const within = Math.abs(Pinsta - Pinsta_theo) < 1.96 * sigmaInsta;
console.log(`   z-score:      ${pp((Pinsta - Pinsta_theo) / sigmaInsta, 3)}     ${within ? '✓ within 1.96σ' : '⚠ outside 1.96σ'}`);

// ── 4. h ∼ Uniform[0,1) (Kolmogorov–Smirnov) ────────────────────────
console.log(`\n── 4. h UNIFORMITY (Kolmogorov–Smirnov) ───────────────────────────`);
const sortedH = [...hValues].sort((a, b) => a - b);
let Dmax = 0;
for (let i = 0; i < N; i++) {
  const Femp = (i + 1) / N;
  const Ftheo = sortedH[i];      // CDF of Uniform[0,1) at x is x
  Dmax = Math.max(Dmax, Math.abs(Femp - Ftheo));
}
// KS critical value at α = 0.01: 1.63 / √N
const Dcrit_001 = 1.63 / Math.sqrt(N);
const Dcrit_005 = 1.36 / Math.sqrt(N);
console.log(`   KS statistic D_N    = ${pp(Dmax, 6)}`);
console.log(`   Critical (α=0.05)   = ${pp(Dcrit_005, 6)}    ${Dmax < Dcrit_005 ? '✓ accept H₀' : '✗ reject'}`);
console.log(`   Critical (α=0.01)   = ${pp(Dcrit_001, 6)}    ${Dmax < Dcrit_001 ? '✓ accept H₀' : '✗ reject'}`);

// ── 5. Chi-squared goodness-of-fit on the tail bins ─────────────────
console.log(`\n── 5. CHI-SQUARED on P(X ≥ T) BUCKETS ─────────────────────────────`);
const buckets = [
  { lo: 1.00, hi: 1.50 },
  { lo: 1.50, hi: 2.00 },
  { lo: 2.00, hi: 3.00 },
  { lo: 3.00, hi: 5.00 },
  { lo: 5.00, hi: 10.00 },
  { lo: 10.00, hi: 25.00 },
  { lo: 25.00, hi: 100.00 },
  { lo: 100.00, hi: Infinity },
];
const Pin = (lo, hi) => {
  // P(lo ≤ X < hi) = P(X ≥ lo) − P(X ≥ hi)
  const Plo = lo === 1.00 ? 1 : 97 / Math.round(lo * 100);
  const Phi = hi === Infinity ? 0 : 97 / Math.round(hi * 100);
  return Plo - Phi;
};
let chi2 = 0;
console.log(`   Bucket            Expected   Observed   (O−E)²/E`);
console.log(`   ─────────────── ────────── ────────── ──────────`);
for (const b of buckets) {
  const obs = crashPoints.filter((cp) => cp >= b.lo && cp < b.hi).length;
  const Pb = Pin(b.lo, b.hi);
  const exp = N * Pb;
  const contrib = (obs - exp) ** 2 / exp;
  chi2 += contrib;
  const label = `[${pp(b.lo, 2)}, ${b.hi === Infinity ? '∞' : pp(b.hi, 2)})`;
  console.log(`   ${label.padEnd(16)}  ${exp.toFixed(0).padStart(8)}   ${String(obs).padStart(8)}   ${pp(contrib, 4).padStart(8)}`);
}
const df = buckets.length - 1;
// Chi-squared critical values at df=7: α=0.05 → 14.07, α=0.01 → 18.48
console.log(`   χ² = ${pp(chi2, 3)}   df = ${df}`);
console.log(`   χ²₀.₀₅,${df} = 14.07    ${chi2 < 14.07 ? '✓ accept H₀' : '⚠ reject at 5%'}`);
console.log(`   χ²₀.₀₁,${df} = 18.48    ${chi2 < 18.48 ? '✓ accept H₀' : '⚠ reject at 1%'}`);

// ── 6. Distribution moments ─────────────────────────────────────────
console.log(`\n── 6. DISTRIBUTION SHAPE ──────────────────────────────────────────`);
const sortedCP = [...crashPoints].sort((a, b) => a - b);
const median = sortedCP[Math.floor(N / 2)];
const mean = crashPoints.reduce((s, x) => s + x, 0) / N;
const p99 = sortedCP[Math.floor(N * 0.99)];
const p999 = sortedCP[Math.floor(N * 0.999)];
const max = sortedCP[N - 1];
// Theoretical median: P(X ≥ T) = 0.5 → 97/(100T) = 0.5 → T = 1.94
const medianTheo = 97 / 50;
console.log(`   Median        empirical = ${pp(median, 2)}x      theoretical = ${pp(medianTheo, 2)}x (1.94)`);
console.log(`   Mean          empirical = ${pp(mean, 2)}x      theoretical = ∞ (heavy tail)`);
console.log(`   99th pctile   empirical = ${pp(p99, 2)}x      theoretical = 97 (97/(100·0.01) when P=0.01)`);
console.log(`   99.9th pctile empirical = ${pp(p999, 2)}x      theoretical = 970`);
console.log(`   Maximum       observed  = ${pp(max, 2)}x      max possible = 97 · 2³²/100 ≈ 4.17×10⁹`);

// ── 7. Numerical edge cases ─────────────────────────────────────────
console.log(`\n── 7. NUMERICAL EDGE CASES ────────────────────────────────────────`);
// h = 0 exactly: 97/1 = 97, floor=97, /100 = 0.97 → clamped to 1.00
// h = 0.029... 97/0.971 = 99.89... → 99 → 0.99 → clamped
// h = 0.03: 97/0.97 = 100 exactly → 100 → 1.00 (no clamp needed)
const edge = (h, expected) => {
  const intVal = Math.round(h * 0x100000000);
  const hFloat = intVal / 0x100000000;
  const raw = Math.floor(97 / (1 - hFloat)) / 100;
  const result = Math.max(1.00, raw);
  console.log(`   h = ${pp(hFloat, 8)}  →  raw = ${pp(raw, 4)}  → X = ${pp(result, 4)}   ${result === expected ? '✓' : '✗ expected ' + expected}`);
};
edge(0,        1.00);   // h=0
edge(0.029,    1.00);   // just below the boundary
edge(0.03,     1.00);   // boundary: 97/0.97 = 100 → X = 1.00
edge(0.031,    1.00);   // just above (97/0.969 = 100.10 → floor 100 → 1.00)
edge(0.05,     1.02);   // 97/0.95 = 102.105 → 102 → 1.02
edge(0.50,     1.94);   // 97/0.5 = 194 → 1.94 (the median!)
// h ≈ 0.99 is NOT exactly representable in IEEE-754; the HMAC bucket
// just below 0.99 rounds h down → X = 96.99 instead of 97.00. This is
// a discretization artifact of the 32-bit h, not a math bug.
edge(0.99,    96.99);
edge(0.999,  970.00);

// ── Verdict ─────────────────────────────────────────────────────────
const allPass = reproMismatches === 0 && hashMismatches === 0
              && Dmax < Dcrit_001
              && chi2 < 18.48
              && within;
console.log(`\n┌──────────────────────────────────────────────────────────────┐`);
console.log(`│  VERDICT: ${allPass ? '✓ AUDIT PASS — math is sound at PhD level   ' : '⚠ AUDIT FAIL — see flagged tests above       '}            │`);
console.log(`└──────────────────────────────────────────────────────────────┘`);
process.exit(allPass ? 0 : 1);
