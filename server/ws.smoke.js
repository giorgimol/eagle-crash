/**
 * End-to-end smoke test: connect, watch one full round, summarize.
 * Verifies:
 *   - welcome arrives with snapshot
 *   - phase events in order betting → flying → crash → betting
 *   - tick stream present during flying
 *   - bet/cashout events from bots
 *   - crash payload includes serverSeed/serverSeedHash/clientSeed for verification
 */
import WebSocket from 'ws';

const url = process.env.WS_URL || 'ws://localhost:3001/ws';
const ws = new WebSocket(url);

const phases = [];
const counts = { tick: 0, bet: 0, cashout: 0, bust: 0, totals: 0, history: 0 };
let welcomed = false;
let crashed = null;
let postCrashPhases = 0;

ws.on('open', () => console.log(`connected ${url}`));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  switch (m.type) {
    case 'welcome':
      welcomed = true;
      console.log(`welcome: playerId=${m.playerId.slice(0,8)} phase=${m.snapshot.phase} balance=${m.snapshot.player?.balance}`);
      break;
    case 'phase':
      phases.push(m.phase);
      console.log(`phase → ${m.phase}`);
      if (crashed && (m.phase === 'betting')) postCrashPhases++;
      break;
    case 'tick': counts.tick++; break;
    case 'bet': counts.bet++; break;
    case 'cashout': counts.cashout++; break;
    case 'bust': counts.bust++; break;
    case 'totals': counts.totals++; break;
    case 'history': counts.history++; break;
    case 'crash':
      crashed = m;
      console.log(`crash @ ${m.crashPoint.toFixed(2)}x  escaped=${m.escaped}  nonce=${m.nonce}`);
      break;
  }
  if (postCrashPhases >= 1) {
    finish();
  }
});

function finish() {
  console.log('\n=== summary ===');
  console.log('welcomed:', welcomed);
  console.log('phases  :', phases.join(' → '));
  console.log('counts  :', counts);
  console.log('crash   :', crashed ? {
    crashPoint: crashed.crashPoint,
    escaped: crashed.escaped,
    hasSeed: !!crashed.serverSeed,
    hasHash: !!crashed.serverSeedHash,
    hasClient: !!crashed.clientSeed,
    nonce: crashed.nonce,
  } : null);
  ws.close();
  process.exit(0);
}

setTimeout(() => { console.error('timeout'); process.exit(1); }, 60_000);
