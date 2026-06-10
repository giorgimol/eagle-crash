/**
 * Verify the operator event fires on crash and carries the right fields.
 * Waits for one crash, prints the operator payload, exits.
 */
import WebSocket from 'ws';

const ws = new WebSocket(process.env.WS_URL || 'ws://localhost:3001/ws');
let firstTotals = null;
let firstCrash  = null;

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'welcome') {
    console.log('welcome totals:', m.snapshot.totals);
    console.log('welcome operator cumulative:', m.snapshot.operator?.cumulative);
  }
  if (m.type === 'totals' && !firstTotals) {
    firstTotals = m;
    console.log('first totals broadcast:', m);
  }
  if (m.type === 'operator' && !firstCrash) {
    firstCrash = m;
    console.log('\noperator payload:');
    console.log('  cumulative:', JSON.stringify(m.cumulative, null, 2));
    console.log('  lastRound :', JSON.stringify(m.lastRound, null, 2));
    console.log('  curRound  :', JSON.stringify(m.curRound, null, 2));
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => { console.error('timeout'); process.exit(1); }, 60_000);
