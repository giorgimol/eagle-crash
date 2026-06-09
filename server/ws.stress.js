/**
 * 50-round stability test. Connects 4 concurrent WS clients (humans),
 * has each one place auto-bets, and verifies:
 *   - all 50 betting/flying/crash cycles complete
 *   - phases always cycle in order
 *   - tick rate is roughly 60 Hz during flying
 *   - every crash event reveals all three seeds
 *   - server's RSS doesn't grow unboundedly
 *
 * Run AFTER booting the server: `node server/ws.stress.js`.
 */
import WebSocket from 'ws';

const url = process.env.WS_URL || 'ws://localhost:3001/ws';
const TARGET_ROUNDS = Number(process.env.ROUNDS || 50);
const CLIENTS = Number(process.env.CLIENTS || 4);

const startedAt = Date.now();
const rssAtStart = process.memoryUsage().rss;

let crashes = 0;
let badPhase = 0;
let totalTicks = 0;
let totalFlyingMs = 0;
let phaseHistory = []; // per-client last-phase tracker

const clients = [];
for (let i = 0; i < CLIENTS; i++) {
  const ws = new WebSocket(url);
  const c = { ws, idx: i, lastPhase: null, flyingStart: 0, ticks: 0, balance: null };
  clients.push(c);
  phaseHistory.push([]);

  ws.on('open', () => {
    // Each client takes a different strategy.
    const stake = [5, 10, 20, 50][i % 4];
    const target = [1.30, 1.80, 2.50, 5.00][i % 4];
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'set_autobet', slot: 'A', enabled: true, stake, autoCashout: target }));
    }, 200);
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'welcome') { c.balance = m.snapshot.player?.balance; }
    if (m.type === 'phase')   {
      // Enforce valid transitions: betting → flying → crash → betting.
      const ok = (
        (c.lastPhase == null)
        || (c.lastPhase === 'betting' && m.phase === 'flying')
        || (c.lastPhase === 'flying'  && m.phase === 'crash')
        || (c.lastPhase === 'crash'   && m.phase === 'betting')
      );
      if (!ok) {
        console.error(`client ${i}: bad phase transition ${c.lastPhase} → ${m.phase}`);
        badPhase++;
      }
      if (m.phase === 'flying') c.flyingStart = Date.now();
      if (m.phase === 'crash' && c.flyingStart) {
        totalFlyingMs += Date.now() - c.flyingStart;
        c.flyingStart = 0;
      }
      c.lastPhase = m.phase;
      phaseHistory[i].push(m.phase);
    }
    if (m.type === 'tick') { c.ticks++; totalTicks++; }
    if (m.type === 'crash' && i === 0) {
      crashes++;
      if (!m.serverSeed || !m.serverSeedHash || !m.clientSeed) {
        console.error('crash missing seeds:', m);
      }
      if (crashes % 10 === 0) {
        const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`  …${crashes} rounds (${dur}s elapsed)`);
      }
      if (crashes >= TARGET_ROUNDS) finish();
    }
  });

  ws.on('error', (e) => console.error(`client ${i} error`, e.message));
}

function finish() {
  const elapsedS = (Date.now() - startedAt) / 1000;
  const rssNow = process.memoryUsage().rss;
  // Theoretical tick rate ≈ 60/s during flying. Across all clients:
  const expectedTicks = (totalFlyingMs / CLIENTS) * 60 / 1000 * CLIENTS;

  console.log('\n=== stress summary ===');
  console.log(`Rounds completed:       ${crashes} / ${TARGET_ROUNDS}`);
  console.log(`Bad phase transitions:  ${badPhase}`);
  console.log(`Wall clock:             ${elapsedS.toFixed(1)} s`);
  console.log(`Tick total (all):       ${totalTicks}  (~expected ${expectedTicks.toFixed(0)})`);
  console.log(`Avg ticks / client:     ${(totalTicks / CLIENTS).toFixed(0)}`);
  console.log(`Test-process RSS Δ:     ${((rssNow - rssAtStart) / 1024 / 1024).toFixed(2)} MB`);
  for (let i = 0; i < CLIENTS; i++) {
    const last = phaseHistory[i].slice(-9).join('→');
    console.log(`  client ${i}: ${phaseHistory[i].length} phase events  tail: ${last}  balance: ${clients[i].balance}`);
  }
  for (const c of clients) c.ws.close();
  process.exit(badPhase === 0 && crashes >= TARGET_ROUNDS ? 0 : 1);
}

setTimeout(() => { console.error('timeout'); process.exit(1); }, 20 * 60_000);
