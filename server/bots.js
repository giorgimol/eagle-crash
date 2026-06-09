/**
 * Fake-multiplayer simulator. Purely cosmetic — bots are real Player
 * objects inside the Game, but they NEVER affect the crash math.
 *
 * Each bot decides during the betting phase whether to play and at what
 * stake. Once in, each bot has a (private, server-side) target multiplier
 * at which they'd cash out — modeled as a heavy-tailed sample so most
 * cash out cheaply and a few hold for the moon.
 */
import { PHASES } from './game.js';

const NAMES = [
  'Giorgi_88', 'EagleHunter', 'Nika22', 'RustamK', 'AnaG',
  'FlyHigh777', 'MountainKing', 'NinoT', 'TbilisiKid', 'BakuBoss',
];

// Stake "buckets" weighted toward small bets (matches what real lobbies look like).
const STAKE_BUCKETS = [
  { stake: 1,   weight: 4 },
  { stake: 5,   weight: 6 },
  { stake: 10,  weight: 6 },
  { stake: 25,  weight: 4 },
  { stake: 50,  weight: 2 },
  { stake: 100, weight: 1 },
];

function pickWeighted(buckets) {
  const total = buckets.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of buckets) {
    r -= b.weight;
    if (r <= 0) return b.stake;
  }
  return buckets[0].stake;
}

// Sample a target cashout in (1, ∞) — heavy-tailed.
//   ~70% cash out under 2.0x, ~20% between 2-5x, ~10% chase the moon.
function sampleCashoutTarget() {
  const r = Math.random();
  if (r < 0.05) return 1.05 + Math.random() * 0.1;            // 1.05 - 1.15 (chicken)
  if (r < 0.45) return 1.20 + Math.random() * 0.8;            // 1.20 - 2.00
  if (r < 0.75) return 2.00 + Math.random() * 3.0;            // 2.00 - 5.00
  if (r < 0.95) return 5.00 + Math.random() * 10.0;           // 5.00 - 15.00
  return 15.00 + Math.random() * 35.0;                        // 15.00 - 50.00 (lottery)
}

export function startBots(game, { count = 8 } = {}) {
  // Register a fixed pool of bots up front so the feed looks like a stable lobby.
  const pool = [];
  for (let i = 0; i < count; i++) {
    const name = NAMES[i % NAMES.length];
    const b = game.registerPlayer({ name, isBot: true, balance: 1_000_000 });
    b._targetCashout = null; // set per round
    pool.push(b);
  }

  game.on('phase', ({ phase, phaseStartedAt, phaseEndsAt }) => {
    if (phase !== PHASES.BETTING) return;

    // For each bot: roll whether they play this round, then schedule a
    // bet placement at a random point in the 5s betting window so the
    // live feed staggers instead of dumping all bets at t=0.
    const windowMs = Math.max(200, phaseEndsAt - phaseStartedAt - 300);
    for (const bot of pool) {
      const playA = Math.random() < 0.85;
      const playB = Math.random() < 0.25;

      if (playA) {
        const delay = Math.random() * windowMs;
        setTimeout(() => placeBotBet(game, bot, 'A'), delay);
      }
      if (playB) {
        const delay = Math.random() * windowMs;
        setTimeout(() => placeBotBet(game, bot, 'B'), delay);
      }
    }
  });

  game.on('tick', ({ multiplier }) => {
    // Bots cash out the moment the live multiplier crosses their private
    // target. They DON'T use the server's auto-cashout machinery because
    // the goal is for the live feed to look human (varied, slightly late).
    for (const bot of pool) {
      for (const slot of ['A', 'B']) {
        const bet = bot.bets[slot];
        if (!bet || bet.status !== 'placed') continue;
        const t = bet._targetCashout;
        if (t != null && multiplier >= t) {
          game.cashOut(bot.id, slot);
        }
      }
    }
  });
}

function placeBotBet(game, bot, slot) {
  if (game.phase !== PHASES.BETTING) return;
  const stake = pickWeighted(STAKE_BUCKETS);
  if (stake > bot.balance) return;

  const r = game.placeBet(bot.id, slot, { stake });
  if (r.ok) {
    // Stash the target on the bet object so we can clear it on round reset.
    bot.bets[slot]._targetCashout = sampleCashoutTarget();
  }
}
