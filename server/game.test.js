/**
 * Smoke test the Game state machine without any WebSocket layer.
 * Plays 2 rounds, logs every phase change, auto-cashout and bust.
 */
import { Game, PHASES } from './game.js';

const game = new Game();
const p1 = game.registerPlayer({ name: 'TestPlayer' });

// Auto-bet slot A every round at 10 stake, auto-cashout at 1.30x (very safe).
game.setAutoBet(p1.id, 'A', { enabled: true, stake: 10, autoCashout: 1.30 });

const logs = [];
game.on('phase',   (e) => logs.push(`PHASE  ${e.phase}  ends in ${(e.phaseEndsAt - Date.now())}ms`));
game.on('crash',   (e) => logs.push(`CRASH  @ ${e.crashPoint.toFixed(2)}x ${e.escaped ? '(escaped)' : ''}`));
game.on('cashout', (e) => logs.push(`CASH   ${e.name}/${e.slot} @ ${e.multiplier.toFixed(2)}x payout=${e.payout}`));
game.on('bust',    (e) => logs.push(`BUST   ${e.name}/${e.slot} stake=${e.stake}`));
game.on('bet',     (e) => logs.push(`BET    ${e.name}/${e.slot} stake=${e.stake} ac=${e.autoCashout ?? '-'}`));

game.start();

let rounds = 0;
game.on('crash', () => {
  rounds += 1;
  if (rounds >= 2) {
    setTimeout(() => {
      game.stop();
      console.log('\n=== EVENT LOG ===');
      for (const l of logs) console.log(l);
      console.log('\n=== FINAL ===');
      const final = game.getPlayer(p1.id);
      console.log(`Balance: ${final.balance}  History size: ${game.history.length}`);
      process.exit(0);
    }, 50);
  }
});

// Hard timeout so we don't wedge.
setTimeout(() => { game.stop(); console.error('TIMEOUT'); process.exit(1); }, 120_000);
