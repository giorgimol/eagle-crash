/**
 * Provably-fair crash math (HMAC-SHA256, RTP exactly 97%).
 *
 * Per-round flow:
 *   1. Server generates a 32-byte random `serverSeed`.
 *   2. Server publishes `sha256(serverSeed)` BEFORE the round — the commitment.
 *   3. Client may set a `clientSeed`; otherwise a random one is used.
 *   4. The round's `nonce` is a strictly increasing integer.
 *   5. crashPoint = crashFromSeeds(serverSeed, clientSeed, nonce).
 *   6. After the round, server reveals serverSeed/clientSeed/nonce so the
 *      player can independently recompute and verify.
 *
 * Math:
 *   combined = HMAC_SHA256(key = serverSeed, msg = clientSeed + ":" + nonce)
 *   h        = (first 8 hex chars of combined as uint32) / 2^32   ∈ [0, 1)
 *   crashPoint = max(1.00, floor(97 / (1 - h)) / 100)
 *
 * The "97" in the numerator IS the house edge. For any cash-out target T > 1,
 *   P(win) = P(crashPoint > T) ≈ 97 / (100 × T)
 *   RTP    = T × P(win) ≈ 0.97
 * exactly, at every target. No separate insta-crash branch needed — the
 * formula naturally floors to 1.00x ~3% of the time (when h ≤ 0.03).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const RTP = 0.97; // 97% — encoded as the numerator constant below

export function randomServerSeed() {
  return randomBytes(32).toString('hex');
}

export function randomClientSeed() {
  return randomBytes(8).toString('hex');
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Deterministic crash point from (serverSeed, clientSeed, nonce).
 * Pure function — same inputs always give the same crash point.
 */
export function crashFromSeeds(serverSeed, clientSeed, nonce) {
  const hmac = createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  // First 8 hex chars → uint32 → normalize to [0, 1).
  const intVal = parseInt(hmac.slice(0, 8), 16);
  const h = intVal / 0x100000000; // 2^32

  // 97-numerator = 3% house edge baked in. Cases where h is small (≲ 0.03)
  // naturally produce floor < 100 → clamped to 1.00x.
  const raw = Math.floor(97 / (1 - h)) / 100;
  return Math.max(1.00, raw);
}

/**
 * Convenience: build a full round commitment without exposing the server seed.
 * The caller stores `serverSeed` privately and only sends `serverSeedHash` to clients.
 */
export function newRoundCommitment(nonce, { clientSeed } = {}) {
  const serverSeed = randomServerSeed();
  const cseed = clientSeed ?? randomClientSeed();
  return {
    nonce,
    serverSeed,                       // KEEP PRIVATE until round ends
    serverSeedHash: sha256Hex(serverSeed),
    clientSeed: cseed,
    crashPoint: crashFromSeeds(serverSeed, cseed, nonce),
  };
}
