/**
 * Eagle Crash — game state machine.
 *
 * Drives the round loop forever: betting (5s) → flying (variable) → crash (3s).
 * Owns:
 *   - per-player state (balance, current bets, auto-bet config)
 *   - the provably-fair commitment for the current round
 *   - the multiplier curve while flying
 *   - the rolling history of completed rounds
 *
 * Exposes:
 *   - registerPlayer / unregisterPlayer
 *   - placeBet, cancelBet, cashOut, setAutoBet, cancelAutoBet
 *   - Events via EventEmitter: 'phase', 'tick', 'crash', 'bet', 'cashout',
 *     'bust', 'history', 'balance', 'autobet'.
 *
 * Everything timing-critical (especially auto-cashout) runs server-side
 * so a slow client cannot win or lose a bet through network latency.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { newRoundCommitment } from './crash.js';

export const PHASES = Object.freeze({
  BETTING: 'betting',
  FLYING:  'flying',
  CRASH:   'crash',
});

// Tunables — match the brief.
const BETTING_MS = 5_000;
const CRASH_MS   = 3_000;
const TICK_HZ    = 60;
const TICK_MS    = Math.round(1000 / TICK_HZ);
// m(t) = GROWTH ^ t, t in seconds.
//
// Genre-leader pacing reference (Wizard of Odds, Aviator/JetX teardowns):
//   JetX increments ~1% every 1/7s → (1.01)^7 ≈ 1.0721 per second.
//   Aviator (Spribe) is reverse-engineered to the same rate.
// At GROWTH = 1.07: 2x at ~10s, 5x at ~24s, 10x at ~34s, 25x at ~48s.
//
// The brief asked for a "fast eagle" feel — original setting was 1.26
// (2x at 3s, 10x at 10s) — but that's ~3.5× faster than shipped casino
// games and reads as urgent rather than dramatic. We slow the start so
// auto-cashout decisions have room to land and the trail has time to
// arc. Trade-off: average round goes ~11s → ~25–30s.
const GROWTH     = 1.07;
const ESCAPE_THRESHOLD = 25.00;     // crashPoint ≥ this → eagle escapes
const HISTORY_SIZE = 20;
const STARTING_BALANCE = 1000;
const MIN_STAKE = 1;
const MAX_STAKE = 500;

const now = () => Date.now();
const round2 = (x) => Math.round(x * 100) / 100;

// Multiplier as a function of elapsed flying time (ms).
export function multiplierAt(elapsedMs) {
  const t = elapsedMs / 1000;
  return Math.max(1.00, round2(Math.pow(GROWTH, t)));
}

// Inverse: when does the multiplier first reach a target?
export function timeForMultiplier(target) {
  if (target <= 1) return 0;
  return (Math.log(target) / Math.log(GROWTH)) * 1000;
}

export class Game extends EventEmitter {
  constructor({ now: nowFn = now } = {}) {
    super();
    this._now = nowFn;
    this.players = new Map();           // id → playerState
    this.history = [];                  // newest first, capped at HISTORY_SIZE
    this.nonce = 0;
    this.roundId = 0;
    this.phase = PHASES.BETTING;
    this.phaseStartedAt = 0;
    this.phaseEndsAt = 0;
    this.commitment = null;             // current round's seeds + crashPoint (private)
    this.multiplier = 1.00;
    this._tickHandle = null;
    this._phaseHandle = null;
    this._started = false;

    // Operator economics (the casino's view).
    // Includes BOTH real players AND bots — bots are cosmetic in terms
    // of the crash math, but their bets+payouts make the operator
    // numbers reflect what a real lobby of similar volume would look
    // like. The client UI tags this clearly.
    this.operator = {
      rounds: 0,
      wagered: 0,
      paidOut: 0,
      sessionStart: this._now(),
      lastRound: null,
    };
    this._curRound = { wagered: 0, paidOut: 0, bets: 0, playerIds: new Set() };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  start() {
    if (this._started) return;
    this._started = true;
    this._enterBetting();
  }

  stop() {
    this._started = false;
    if (this._tickHandle)  { clearInterval(this._tickHandle); this._tickHandle = null; }
    if (this._phaseHandle) { clearTimeout(this._phaseHandle); this._phaseHandle = null; }
  }

  // ── Players ─────────────────────────────────────────────────────────────

  registerPlayer({ id, name, isBot = false, balance = STARTING_BALANCE } = {}) {
    const pid = id ?? randomUUID();
    const p = {
      id: pid,
      name: name ?? `Player_${pid.slice(0, 4)}`,
      balance,
      isBot,
      bets:    { A: null, B: null },     // active bet slots for the current round
      autoBet: { A: null, B: null },     // recurring config: {stake, autoCashout}
    };
    this.players.set(pid, p);
    return p;
  }

  unregisterPlayer(playerId) {
    this.players.delete(playerId);
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  // ── Snapshot for new connections ─────────────────────────────────────────

  snapshot(playerId) {
    const p = this.players.get(playerId);
    return {
      phase: this.phase,
      phaseStartedAt: this.phaseStartedAt,
      phaseEndsAt: this.phaseEndsAt,
      nowOnServer: this._now(),
      multiplier: this.multiplier,
      // Public commitment (hash + nonce). Never expose serverSeed until crash.
      commitment: this.commitment && {
        nonce: this.commitment.nonce,
        serverSeedHash: this.commitment.serverSeedHash,
        clientSeed: this.commitment.clientSeed,
      },
      history: this.history.slice(),
      player: p && this._publicPlayer(p),
      totals: this._roundTotals(),
      operator: this.operatorSnapshot(),
    };
  }

  _publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      balance: round2(p.balance),
      bets: {
        A: p.bets.A && { ...p.bets.A },
        B: p.bets.B && { ...p.bets.B },
      },
      autoBet: {
        A: p.autoBet.A && { ...p.autoBet.A },
        B: p.autoBet.B && { ...p.autoBet.B },
      },
    };
  }

  _roundTotals() {
    return {
      players: this._curRound.playerIds.size,
      wagered: round2(this._curRound.wagered),
      paidOut: round2(this._curRound.paidOut),
    };
  }

  operatorSnapshot() {
    const cum = this.operator;
    const sessionMs = this._now() - cum.sessionStart;
    const ggr = round2(cum.wagered - cum.paidOut);
    return {
      cumulative: {
        rounds:   cum.rounds,
        wagered:  round2(cum.wagered),
        paidOut:  round2(cum.paidOut),
        ggr,
        rtp:      cum.wagered > 0 ? cum.paidOut / cum.wagered : 0,
        houseEdge: cum.wagered > 0 ? 1 - (cum.paidOut / cum.wagered) : 0,
        sessionStart: cum.sessionStart,
        sessionMs,
      },
      lastRound: cum.lastRound,
      curRound: {
        wagered: round2(this._curRound.wagered),
        paidOut: round2(this._curRound.paidOut),
        bets:    this._curRound.bets,
        players: this._curRound.playerIds.size,
      },
    };
  }

  // ── Player actions ──────────────────────────────────────────────────────

  placeBet(playerId, slot, { stake, autoCashout = null } = {}) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'unknown_player' };
    if (this.phase !== PHASES.BETTING) return { ok: false, error: 'not_betting_phase' };
    if (!['A', 'B'].includes(slot))   return { ok: false, error: 'bad_slot' };
    if (p.bets[slot])                 return { ok: false, error: 'already_placed' };

    const s = Number(stake);
    if (!Number.isFinite(s) || s < MIN_STAKE) return { ok: false, error: 'stake_too_low' };
    if (s > MAX_STAKE)                        return { ok: false, error: 'stake_too_high' };
    if (s > p.balance)                        return { ok: false, error: 'insufficient_balance' };

    const ac = this._normalizeAutoCashout(autoCashout);
    p.balance = round2(p.balance - s);
    p.bets[slot] = { stake: s, autoCashout: ac, status: 'placed', placedAt: this._now() };

    // Operator economics: money in
    this._curRound.wagered = round2(this._curRound.wagered + s);
    this._curRound.bets   += 1;
    this._curRound.playerIds.add(p.id);

    this.emit('bet', {
      playerId: p.id, name: p.name, slot, stake: s, autoCashout: ac, isBot: p.isBot,
      balance: p.balance,
    });
    this.emit('balance', { playerId: p.id, balance: p.balance });
    return { ok: true, bet: { ...p.bets[slot] } };
  }

  cancelBet(playerId, slot) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'unknown_player' };
    if (this.phase !== PHASES.BETTING) return { ok: false, error: 'not_betting_phase' };
    const bet = p.bets[slot];
    if (!bet) return { ok: false, error: 'no_bet' };

    p.balance = round2(p.balance + bet.stake);
    p.bets[slot] = null;
    // Operator economics: refund the wager
    this._curRound.wagered = round2(this._curRound.wagered - bet.stake);
    this.emit('balance', { playerId: p.id, balance: p.balance });
    this.emit('bet_cancelled', { playerId: p.id, slot });
    return { ok: true };
  }

  cashOut(playerId, slot) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'unknown_player' };
    if (this.phase !== PHASES.FLYING) return { ok: false, error: 'not_flying' };
    const bet = p.bets[slot];
    if (!bet || bet.status !== 'placed') return { ok: false, error: 'no_active_bet' };

    return this._settleCashout(p, slot, this.multiplier);
  }

  setAutoBet(playerId, slot, { enabled, stake, autoCashout = null } = {}) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, error: 'unknown_player' };
    if (!['A', 'B'].includes(slot)) return { ok: false, error: 'bad_slot' };

    if (!enabled) {
      p.autoBet[slot] = null;
      this.emit('autobet', { playerId: p.id, slot, config: null });
      return { ok: true };
    }
    const s = Number(stake);
    if (!Number.isFinite(s) || s < MIN_STAKE || s > MAX_STAKE) {
      return { ok: false, error: 'bad_stake' };
    }
    const ac = this._normalizeAutoCashout(autoCashout);
    p.autoBet[slot] = { stake: s, autoCashout: ac };
    this.emit('autobet', { playerId: p.id, slot, config: { ...p.autoBet[slot] } });
    return { ok: true };
  }

  _normalizeAutoCashout(val) {
    if (val == null) return null;
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 1) return null;
    return round2(n);
  }

  _settleCashout(p, slot, multiplier) {
    const bet = p.bets[slot];
    const payout = round2(bet.stake * multiplier);
    bet.status = 'cashed';
    bet.cashedAt = multiplier;
    bet.payout = payout;
    p.balance = round2(p.balance + payout);

    // Operator economics: money out
    this._curRound.paidOut = round2(this._curRound.paidOut + payout);

    this.emit('cashout', {
      playerId: p.id, name: p.name, slot, multiplier,
      stake: bet.stake, payout, isBot: p.isBot, balance: p.balance,
    });
    this.emit('balance', { playerId: p.id, balance: p.balance });
    return { ok: true, multiplier, payout, balance: p.balance };
  }

  // ── Phase machinery ─────────────────────────────────────────────────────

  _enterBetting() {
    this.phase = PHASES.BETTING;
    this.phaseStartedAt = this._now();
    this.phaseEndsAt = this.phaseStartedAt + BETTING_MS;
    this.multiplier = 1.00;
    this.roundId += 1;
    this.nonce += 1;

    // Reset per-round bet state for everyone.
    for (const p of this.players.values()) {
      p.bets.A = null;
      p.bets.B = null;
    }

    // Reset round economics
    this._curRound = { wagered: 0, paidOut: 0, bets: 0, playerIds: new Set() };

    // Generate this round's commitment up front. Keep serverSeed PRIVATE
    // until the crash phase; broadcast only serverSeedHash + clientSeed + nonce.
    this.commitment = newRoundCommitment(this.nonce);

    this.emit('phase', {
      phase: this.phase,
      phaseStartedAt: this.phaseStartedAt,
      phaseEndsAt: this.phaseEndsAt,
      commitment: {
        nonce: this.commitment.nonce,
        serverSeedHash: this.commitment.serverSeedHash,
        clientSeed: this.commitment.clientSeed,
      },
    });

    // Apply auto-bets right after the phase event fires (so listeners see
    // the betting phase first, then the auto-bets land on top).
    this._applyAutoBets();

    this._phaseHandle = setTimeout(() => this._enterFlying(), BETTING_MS);
  }

  _applyAutoBets() {
    for (const p of this.players.values()) {
      for (const slot of ['A', 'B']) {
        const cfg = p.autoBet[slot];
        if (!cfg) continue;
        if (p.bets[slot]) continue;
        if (cfg.stake > p.balance) {
          // Out of money — silently disable so we don't spam errors.
          p.autoBet[slot] = null;
          this.emit('autobet', {
            playerId: p.id, slot, config: null, reason: 'insufficient_balance',
          });
          continue;
        }
        this.placeBet(p.id, slot, { stake: cfg.stake, autoCashout: cfg.autoCashout });
      }
    }
  }

  _enterFlying() {
    this.phase = PHASES.FLYING;
    this.phaseStartedAt = this._now();
    // phaseEndsAt is computed dynamically from the crash point.
    const crashPoint = this.commitment.crashPoint;
    this.phaseEndsAt = this.phaseStartedAt + Math.ceil(timeForMultiplier(crashPoint));
    this.multiplier = 1.00;

    this.emit('phase', {
      phase: this.phase,
      phaseStartedAt: this.phaseStartedAt,
      phaseEndsAt: this.phaseEndsAt,
      // Do NOT leak crashPoint here. Clients learn it at the crash event.
    });

    this._tickHandle = setInterval(() => this._tick(), TICK_MS);
  }

  _tick() {
    const elapsed = this._now() - this.phaseStartedAt;
    const m = multiplierAt(elapsed);
    this.multiplier = m;

    // 1) Auto-cashouts fire the instant the curve crosses each target.
    //    Important: this runs BEFORE the crash check so an auto-cashout
    //    that lands exactly at crashPoint still wins.
    this._fireAutoCashouts(m);

    this.emit('tick', { multiplier: m, elapsedMs: elapsed });

    if (m >= this.commitment.crashPoint) {
      this._enterCrash();
    }
  }

  _fireAutoCashouts(m) {
    for (const p of this.players.values()) {
      for (const slot of ['A', 'B']) {
        const bet = p.bets[slot];
        if (!bet || bet.status !== 'placed') continue;
        if (bet.autoCashout != null && m >= bet.autoCashout) {
          // Snap the cash-out to the configured target (not the noisy live m)
          // so the player sees exactly what they asked for.
          this._settleCashout(p, slot, bet.autoCashout);
        }
      }
    }
  }

  _enterCrash() {
    if (this._tickHandle) { clearInterval(this._tickHandle); this._tickHandle = null; }

    const crashPoint = this.commitment.crashPoint;
    const escaped = crashPoint >= ESCAPE_THRESHOLD;
    this.phase = PHASES.CRASH;
    this.phaseStartedAt = this._now();
    this.phaseEndsAt = this.phaseStartedAt + CRASH_MS;
    this.multiplier = crashPoint;

    // Any still-placed bets bust.
    const busts = [];
    for (const p of this.players.values()) {
      for (const slot of ['A', 'B']) {
        const bet = p.bets[slot];
        if (!bet || bet.status !== 'placed') continue;
        bet.status = 'bust';
        bet.cashedAt = null;
        bet.payout = 0;
        busts.push({ playerId: p.id, name: p.name, slot, stake: bet.stake, isBot: p.isBot });
      }
    }
    for (const b of busts) this.emit('bust', b);

    const revealed = {
      nonce: this.commitment.nonce,
      serverSeed: this.commitment.serverSeed,
      serverSeedHash: this.commitment.serverSeedHash,
      clientSeed: this.commitment.clientSeed,
      crashPoint,
      escaped,
    };

    // Append to history (newest first).
    this.history.unshift(revealed);
    if (this.history.length > HISTORY_SIZE) this.history.length = HISTORY_SIZE;

    this.emit('phase', {
      phase: this.phase,
      phaseStartedAt: this.phaseStartedAt,
      phaseEndsAt: this.phaseEndsAt,
    });
    this.emit('crash', { ...revealed });
    this.emit('history', { round: revealed });

    // Finalize operator economics for this round
    const r = this._curRound;
    const lastRound = {
      nonce: revealed.nonce,
      crashPoint: revealed.crashPoint,
      escaped:    revealed.escaped,
      wagered: round2(r.wagered),
      paidOut: round2(r.paidOut),
      ggr:     round2(r.wagered - r.paidOut),
      bets:    r.bets,
      players: r.playerIds.size,
    };
    this.operator.rounds  += 1;
    this.operator.wagered  = round2(this.operator.wagered + r.wagered);
    this.operator.paidOut  = round2(this.operator.paidOut + r.paidOut);
    this.operator.lastRound = lastRound;
    this.emit('operator', this.operatorSnapshot());

    this._phaseHandle = setTimeout(() => this._enterBetting(), CRASH_MS);
  }
}
