/**
 * Eagle Crash — HTTP + WebSocket entry point.
 *
 * - Serves /public statically for the SPA.
 * - Exposes /health for sanity checks.
 * - Upgrades WebSocket connections at /ws, registers each connection as
 *   a Player in the Game, and forwards events both directions.
 *
 * WebSocket protocol (JSON over text frames):
 *
 *   Server → Client
 *     { type: 'welcome',     playerId, snapshot }
 *     { type: 'phase',       phase, phaseStartedAt, phaseEndsAt, commitment? }
 *     { type: 'tick',        multiplier, elapsedMs }
 *     { type: 'crash',       crashPoint, escaped, serverSeed, serverSeedHash, clientSeed, nonce }
 *     { type: 'bet',         playerId, name, slot, stake, autoCashout, isBot }
 *     { type: 'cashout',     playerId, name, slot, multiplier, payout, isBot }
 *     { type: 'bust',        playerId, name, slot, stake, isBot }
 *     { type: 'bet_cancelled', playerId, slot }
 *     { type: 'history',     round }
 *     { type: 'balance',     balance }
 *     { type: 'autobet',     slot, config, reason? }
 *     { type: 'totals',      players, wagered }
 *     { type: 'error',       code, message }
 *
 *   Client → Server
 *     { type: 'set_name',     name }
 *     { type: 'place_bet',    slot, stake, autoCashout? }
 *     { type: 'cancel_bet',   slot }
 *     { type: 'cash_out',     slot }
 *     { type: 'set_autobet',  slot, enabled, stake?, autoCashout? }
 *     { type: 'set_client_seed', clientSeed }   // future: per-player seed override
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Game } from './game.js';
import { startBots } from './bots.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'eagle-crash', players: game.players.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const game = new Game();

// ── Broadcast helpers ────────────────────────────────────────────────────

const realClients = new Set(); // ws connections for human players (bots have no socket)

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of realClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function sendToPlayer(playerId, msg) {
  for (const ws of realClients) {
    if (ws.playerId === playerId && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

// ── Game → clients ──────────────────────────────────────────────────────

game.on('phase', (e)   => broadcast({ type: 'phase', ...e }));
game.on('tick',  (e)   => broadcast({ type: 'tick',  ...e }));
game.on('crash', (e)   => broadcast({ type: 'crash', ...e }));
game.on('bet',   (e)   => broadcast({ type: 'bet',   ...e }));
game.on('bet_cancelled', (e) => broadcast({ type: 'bet_cancelled', ...e }));
game.on('cashout', (e) => broadcast({ type: 'cashout', ...e }));
game.on('bust',  (e)   => broadcast({ type: 'bust', ...e }));
game.on('history', (e) => broadcast({ type: 'history', round: e.round }));

// Per-player balance is private; route it just to that player's socket.
game.on('balance', ({ playerId, balance }) => {
  sendToPlayer(playerId, { type: 'balance', balance });
});
game.on('autobet', ({ playerId, slot, config, reason }) => {
  sendToPlayer(playerId, { type: 'autobet', slot, config, reason });
});

// Coarse totals tick (~2 Hz) so the live-feed header doesn't redraw on every event.
setInterval(() => {
  broadcast({ type: 'totals', ...game._roundTotals() });
}, 500);

// ── Client connection lifecycle ─────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const player = game.registerPlayer({ name: pickGuestName(req) });
  ws.playerId = player.id;
  realClients.add(ws);

  send(ws, { type: 'welcome', playerId: player.id, snapshot: game.snapshot(player.id) });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, { type: 'error', code: 'bad_json' }); }

    try {
      handleClientMessage(ws, msg);
    } catch (err) {
      console.error('[ws] handler error', err);
      send(ws, { type: 'error', code: 'internal', message: String(err.message || err) });
    }
  });

  ws.on('close', () => {
    realClients.delete(ws);
    game.unregisterPlayer(ws.playerId);
  });
});

function handleClientMessage(ws, msg) {
  const pid = ws.playerId;
  switch (msg.type) {
    case 'set_name': {
      const p = game.getPlayer(pid);
      if (p && typeof msg.name === 'string' && msg.name.trim()) {
        p.name = msg.name.trim().slice(0, 24);
      }
      return;
    }
    case 'place_bet': {
      const r = game.placeBet(pid, msg.slot, { stake: msg.stake, autoCashout: msg.autoCashout });
      if (!r.ok) send(ws, { type: 'error', code: r.error, message: 'place_bet failed' });
      return;
    }
    case 'cancel_bet': {
      const r = game.cancelBet(pid, msg.slot);
      if (!r.ok) send(ws, { type: 'error', code: r.error, message: 'cancel_bet failed' });
      return;
    }
    case 'cash_out': {
      const r = game.cashOut(pid, msg.slot);
      if (!r.ok) send(ws, { type: 'error', code: r.error, message: 'cash_out failed' });
      return;
    }
    case 'set_autobet': {
      const r = game.setAutoBet(pid, msg.slot, {
        enabled: !!msg.enabled,
        stake:   msg.stake,
        autoCashout: msg.autoCashout,
      });
      if (!r.ok) send(ws, { type: 'error', code: r.error, message: 'set_autobet failed' });
      return;
    }
    default:
      send(ws, { type: 'error', code: 'unknown_type', message: `unknown msg type ${msg.type}` });
  }
}

function pickGuestName(req) {
  // Just a friendly default; clients can override via set_name.
  const ip = (req.socket.remoteAddress || 'guest').slice(-4);
  return `Guest_${ip}`;
}

// ── Boot ────────────────────────────────────────────────────────────────

game.start();
startBots(game);

server.listen(PORT, () => {
  console.log(`[eagle-crash] http://localhost:${PORT}  (ws on /ws)`);
});

const shutdown = (signal) => {
  console.log(`\n[eagle-crash] ${signal}, shutting down`);
  game.stop();
  wss.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
