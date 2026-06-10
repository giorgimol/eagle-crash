/**
 * End-to-end test: run 2 rounds, save state, restart, confirm restore.
 */
import { Game } from './game.js';
import { flushSync, loadState } from './persistence.js';

async function run() {
  console.log('=== phase 1: fresh game, run 2 rounds ===');
  const g1 = new Game();
  g1.start();
  await new Promise((resolve) => {
    let rounds = 0;
    g1.on('operator', (snap) => {
      rounds += 1;
      const lr = snap.lastRound;
      console.log(`  round ${rounds} crashed @ ${lr.crashPoint.toFixed(2)}x  ggr=${lr.ggr}`);
      if (rounds >= 2) {
        g1.stop();
        flushSync();
        resolve();
      }
    });
  });

  const fromDisk = loadState();
  console.log(`\n=== disk after phase 1 ===`);
  console.log(`  rounds: ${fromDisk?.operator?.rounds}  nonce: ${fromDisk?.nonce}  history: ${fromDisk?.history?.length}`);

  console.log(`\n=== phase 2: fresh process, should restore from disk ===`);
  const g2 = new Game();
  console.log(`  g2 rounds after construction: ${g2.operator.rounds}`);
  console.log(`  g2 nonce after construction:  ${g2.nonce}`);
  console.log(`  g2 history length:            ${g2.history.length}`);

  if (g2.operator.rounds === fromDisk.operator.rounds &&
      g2.nonce === fromDisk.nonce &&
      g2.history.length === fromDisk.history.length) {
    console.log('\n  ✓ PASS — state restored correctly');
    process.exit(0);
  } else {
    console.log('\n  ✗ FAIL — state did not match');
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
