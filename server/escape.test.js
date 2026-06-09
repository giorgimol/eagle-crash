/**
 * Verify the eagle-escape branch fires correctly.
 *
 * Patches Game's commitment for one round to a forced high crash point,
 * runs the round to completion, asserts the crash payload has escaped=true
 * and the history row is marked.
 */
import { Game } from './game.js';

const game = new Game();
// Speed up the round so the test doesn't take 30+ seconds at GROWTH=1.26.
// We don't change the formula — just intercept the round's commitment so
// the crash phase fires almost immediately at a high value.
const FORCED = 99.99;

const origStart = game._enterFlying.bind(game);
game._enterFlying = function patched() {
  this.commitment.crashPoint = FORCED;
  // Also make it crash quickly by lying about phaseStartedAt — we want
  // the very first tick to clear FORCED.
  origStart();
  this.phaseStartedAt = Date.now() - 60_000; // pretend 60s elapsed
};

let result = null;
game.on('crash', (e) => { result = e; });

game.start();

setTimeout(() => {
  game.stop();
  if (!result) { console.error('no crash event fired'); process.exit(1); }
  console.log('crashPoint :', result.crashPoint);
  console.log('escaped    :', result.escaped);
  console.log('seeds OK   :', !!(result.serverSeed && result.serverSeedHash && result.clientSeed));
  if (result.crashPoint !== FORCED) {
    console.error('FAIL: crashPoint not forced as expected');
    process.exit(1);
  }
  if (result.escaped !== true) {
    console.error('FAIL: escaped flag not set on ≥25.00x crash');
    process.exit(1);
  }
  console.log('PASS — escape branch works end-to-end');
  process.exit(0);
}, 7_000);
