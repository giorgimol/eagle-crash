/**
 * Eagle Crash — client.
 *
 * - Holds a thin in-browser copy of the round state, driven by WebSocket messages.
 * - Smoothly interpolates the multiplier between server ticks so the number reads
 *   continuously rather than jumping at 60 Hz.
 * - Drives the canvas Scene via requestAnimationFrame.
 * - Runs provably-fair verification locally (WebCrypto HMAC-SHA256, mirrors server math).
 */
import { createScene } from './scene.js';

// ── State ─────────────────────────────────────────────────────────────

const state = {
  ws: null,
  connected: false,
  playerId: null,
  balance: 1000,
  phase: 'connecting',
  phaseStartedAt: 0,
  phaseEndsAt: 0,
  serverClockSkew: 0,         // ms; server_now - client_now at welcome time
  // multiplier: latest authoritative value + linear interp between ticks
  multiplier: 1.00,
  lastTickMs: 0,              // performance.now() when last tick arrived
  lastTickElapsedMs: 0,       // game elapsed at last tick
  // round
  commitment: null,           // { nonce, serverSeedHash, clientSeed }
  history: [],                // [{ nonce, serverSeed, serverSeedHash, clientSeed, crashPoint, escaped }]
  // bets
  bets:   { A: null, B: null },
  autoBet:{ A: false, B: false },
  // crash anim
  crashElapsed: 0,
  crashEscaped: false,
  // operator P&L
  operator: null,
};

// Round-result message accumulator (shown briefly in stage-sub)
let lastResultText = '';
let lastResultUntil = 0;

// ── DOM helpers ───────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ── WebSocket ────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { state.connected = true; setPhaseLabel(); };
  ws.onclose = () => {
    state.connected = false; setPhaseLabel('disconnected');
    setTimeout(connect, 1500); // light reconnect — fine for demo
  };
  ws.onerror = () => { /* swallow; close will fire */ };
  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome': onWelcome(msg); break;
    case 'phase':   onPhase(msg);   break;
    case 'tick':    onTick(msg);    break;
    case 'crash':   onCrash(msg);   break;
    case 'bet':     onBet(msg);     break;
    case 'bet_cancelled': onBetCancelled(msg); break;
    case 'cashout': onCashout(msg); break;
    case 'bust':    onBust(msg);    break;
    case 'history': onHistory(msg); break;
    case 'balance': onBalance(msg); break;
    case 'autobet': onAutobet(msg); break;
    case 'totals':  onTotals(msg);  break;
    case 'operator': onOperator(msg); break;
    case 'error':   console.warn('[server]', msg.code, msg.message); break;
    default: console.warn('unknown msg', msg);
  }
}

function onWelcome(msg) {
  state.playerId = msg.playerId;
  const s = msg.snapshot;
  state.serverClockSkew = s.nowOnServer - Date.now();
  state.phase = s.phase;
  state.phaseStartedAt = s.phaseStartedAt;
  state.phaseEndsAt = s.phaseEndsAt;
  state.multiplier = s.multiplier;
  state.commitment = s.commitment;
  state.history = s.history;
  state.balance = s.player?.balance ?? 1000;
  // Adopt server's view of our bets/autoBet on rejoin.
  if (s.player) {
    state.bets = s.player.bets;
    state.autoBet.A = !!s.player.autoBet?.A;
    state.autoBet.B = !!s.player.autoBet?.B;
  }
  renderHistory();
  renderBalance();
  renderBets();
  setPhaseLabel();
  $('#feed-players').textContent = s.totals.players;
  $('#feed-wagered').textContent = s.totals.wagered.toFixed(2);
  $('#feed-won').textContent     = (s.totals.paidOut ?? 0).toFixed(2);
  if (s.operator) { state.operator = s.operator; if (!$('#house-modal').hidden) renderHouseModal(); }
}

function onPhase(msg) {
  state.phase = msg.phase;
  state.phaseStartedAt = msg.phaseStartedAt;
  state.phaseEndsAt = msg.phaseEndsAt;

  if (msg.phase === 'betting') {
    state.commitment = msg.commitment;
    state.multiplier = 1.00;
    state.lastTickMs = 0;
    state.lastTickElapsedMs = 0;
    state.crashElapsed = 0;
    state.crashEscaped = false;
    // Reset displayed slot statuses for the new round.
    state.bets = { A: null, B: null };
    renderBets();
    // Clear feed for the new round — keep the empty placeholder ready.
    const ul = $('#feed-list');
    ul.replaceChildren();
    const empty = document.createElement('li');
    empty.id = 'feed-empty';
    empty.className = 'feed-empty';
    empty.textContent = 'Waiting for action…';
    ul.appendChild(empty);
  }
  if (msg.phase === 'flying') {
    state.lastTickMs = performance.now();
    state.lastTickElapsedMs = 0;
  }
  if (msg.phase === 'crash') {
    state.crashElapsed = 0;
  }
  setPhaseLabel();
}

function onTick(msg) {
  state.multiplier = msg.multiplier;
  state.lastTickMs = performance.now();
  state.lastTickElapsedMs = msg.elapsedMs;
}

function onCrash(msg) {
  state.multiplier = msg.crashPoint;
  state.crashEscaped = !!msg.escaped;
  state.commitment = {
    nonce: msg.nonce,
    serverSeedHash: msg.serverSeedHash,
    clientSeed: msg.clientSeed,
  };
  // Determine our personal outcome on this round.
  const wins = [];
  const losses = [];
  for (const slot of ['A', 'B']) {
    const b = state.bets[slot];
    if (!b) continue;
    if (b.status === 'cashed') wins.push(`+${(b.payout - b.stake).toFixed(2)}`);
    else if (b.status === 'bust' || b.status === 'placed') losses.push(`-${b.stake.toFixed(2)}`);
  }
  if (wins.length || losses.length) {
    lastResultText = [wins.length ? `You won ${wins.join(' / ')}` : '',
                      losses.length ? `You lost ${losses.join(' / ')}` : '']
                     .filter(Boolean).join('  ·  ');
    lastResultUntil = performance.now() + 3000;
  }
}

function onBet(msg) {
  if (msg.playerId === state.playerId) {
    state.bets[msg.slot] = {
      stake: msg.stake, autoCashout: msg.autoCashout, status: 'placed',
    };
    renderBets();
  }
  pushFeed({
    name: msg.name, slot: msg.slot,
    text: `bet ${msg.stake}${msg.autoCashout ? ` @ ${msg.autoCashout.toFixed(2)}x auto` : ''}`,
    cls: 'pending',
  });
}

function onBetCancelled(msg) {
  if (msg.playerId === state.playerId) {
    state.bets[msg.slot] = null;
    renderBets();
  }
}

function onCashout(msg) {
  if (msg.playerId === state.playerId) {
    const b = state.bets[msg.slot];
    if (b) { b.status = 'cashed'; b.cashedAt = msg.multiplier; b.payout = msg.payout; }
    renderBets();
    flashCashout(msg.slot, msg.payout - msg.stake);
  }
  pushFeed({
    name: msg.name, slot: msg.slot,
    text: `cashed @ ${msg.multiplier.toFixed(2)}x`,
    deltaText: `+${(msg.payout - msg.stake).toFixed(2)}`,
    cls: 'win',
  });
}

function onBust(msg) {
  if (msg.playerId === state.playerId) {
    const b = state.bets[msg.slot];
    if (b) { b.status = 'bust'; }
    renderBets();
  }
  pushFeed({
    name: msg.name, slot: msg.slot,
    text: `bust`,
    deltaText: `-${msg.stake.toFixed(2)}`,
    cls: 'loss',
  });
}

function onHistory(msg) {
  state.history.unshift(msg.round);
  if (state.history.length > 20) state.history.length = 20;
  renderHistory({ popLatest: true });
}

function onBalance(msg) {
  state.balance = msg.balance;
  renderBalance();
}

function onAutobet(msg) {
  state.autoBet[msg.slot] = msg.config != null;
  renderAutoBetToggle(msg.slot);
}

function onTotals(msg) {
  $('#feed-players').textContent = msg.players;
  $('#feed-wagered').textContent = (msg.wagered ?? 0).toFixed(2);
  $('#feed-won').textContent     = (msg.paidOut ?? 0).toFixed(2);
}

function onOperator(snap) {
  state.operator = snap;
  if (!$('#house-modal').hidden) renderHouseModal();
}

// ── Render: top bar ──────────────────────────────────────────────────

function renderBalance() {
  $('#balance-value').textContent = state.balance.toFixed(2);
}

function chipClass(crashPoint, escaped) {
  if (escaped)             return 'chip gold escape';
  if (crashPoint >= 10)    return 'chip gold';
  if (crashPoint >= 2)     return 'chip green';
  return 'chip red';
}

function renderHistory({ popLatest = false } = {}) {
  const strip = $('#history-strip');
  strip.replaceChildren();
  state.history.forEach((r, i) => {
    const el = document.createElement('button');
    el.className = chipClass(r.crashPoint, r.escaped) + (popLatest && i === 0 ? ' new' : '');
    el.textContent = `${r.crashPoint.toFixed(2)}x`;
    el.title = `Round #${r.nonce}`;
    el.addEventListener('click', () => showChipDetail(r));
    strip.appendChild(el);
  });
}

// ── Render: bet panels ───────────────────────────────────────────────

function renderBets() {
  for (const slot of ['A', 'B']) {
    const card    = document.querySelector(`.bet-slot[data-slot="${slot}"]`);
    const place   = $(`#place-${slot}`);
    const cash    = $(`#cashout-${slot}`);
    const status  = $(`#status-${slot}`);
    const stakeIn = $(`#stake-${slot}`);
    const bet = state.bets[slot];

    const isBetting = state.phase === 'betting';
    const isFlying  = state.phase === 'flying';

    if (card) card.classList.toggle('has-bet', !!bet);

    place.textContent = bet ? 'Placed' : `Place ${stakeIn.value || 0}`;
    place.disabled = !!bet || !isBetting;
    place.classList.toggle('pulse', !bet && isBetting);

    // Cash-out button shows projected payout in real time — genre standard.
    const canCash = !!bet && bet.status === 'placed' && isFlying;
    cash.disabled = !canCash;
    if (canCash) {
      cash.textContent = `Cash Out ${(bet.stake * state.multiplier).toFixed(2)}`;
    } else if (bet?.status === 'cashed') {
      cash.textContent = `Cashed +${(bet.payout - bet.stake).toFixed(2)}`;
    } else {
      cash.textContent = 'Cash Out';
    }

    if (!bet) {
      status.textContent = isBetting ? 'ready' : 'idle';
      status.className = 'bet-status';
    } else if (bet.status === 'placed') {
      const m = state.multiplier;
      status.textContent = isFlying ? `${(bet.stake * m).toFixed(2)} @ ${m.toFixed(2)}x` : `staked ${bet.stake}`;
      status.className = 'bet-status placed';
    } else if (bet.status === 'cashed') {
      status.textContent = `cashed @ ${bet.cashedAt.toFixed(2)}x · +${(bet.payout - bet.stake).toFixed(2)}`;
      status.className = 'bet-status cashed';
    } else if (bet.status === 'bust') {
      status.textContent = `bust · -${bet.stake.toFixed(2)}`;
      status.className = 'bet-status bust';
    }
  }
}

function renderAutoBetToggle(slot) {
  $(`#ab-on-${slot}`).checked = state.autoBet[slot];
}

// ── Render: phase label / multiplier color ───────────────────────────

function setPhaseLabel(forced) {
  const label = $('#phase-label');
  const mult  = $('#multiplier');
  const sub   = $('#phase-sub');
  if (forced === 'disconnected') {
    label.textContent = 'Disconnected — retrying…';
    label.dataset.phase = 'connecting';
    mult.textContent = '—';
    return;
  }
  switch (state.phase) {
    case 'connecting':
      label.textContent = 'Connecting…';
      label.dataset.phase = 'connecting';
      break;
    case 'betting':
      label.textContent = 'Place your bets';
      label.dataset.phase = 'betting';
      mult.classList.remove('crashing', 'escaped');
      mult.textContent = '1.00x';
      break;
    case 'flying':
      label.textContent = '✈ In flight';
      label.dataset.phase = 'flying';
      mult.classList.remove('crashing', 'escaped');
      break;
    case 'crash':
      label.textContent = state.crashEscaped ? '☁ Escaped' : '✕ Crashed';
      label.dataset.phase = state.crashEscaped ? 'escape' : 'crash';
      mult.classList.add(state.crashEscaped ? 'escaped' : 'crashing');
      break;
  }
  sub.textContent = '';
}

// ── Live feed ────────────────────────────────────────────────────────

const FEED_MAX = 60;
function initialsFor(name) {
  const trimmed = (name || '?').replace(/[^A-Za-z0-9]/g, '');
  return (trimmed[0] || '?').toUpperCase();
}
function pushFeed({ name, slot, text, deltaText, cls }) {
  const ul = $('#feed-list');
  const empty = ul.querySelector('#feed-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  const avatar    = document.createElement('span');
  const nameSpan  = document.createElement('span');
  const multSpan  = document.createElement('span');
  const deltaSpan = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = initialsFor(name);
  nameSpan.className = 'name';
  nameSpan.textContent = `${name} · ${slot}`;
  multSpan.className = 'mult';
  multSpan.textContent = text;
  deltaSpan.className = `delta ${cls}`;
  deltaSpan.textContent = deltaText || '';
  li.append(avatar, nameSpan, multSpan, deltaSpan);
  ul.prepend(li);
  while (ul.children.length > FEED_MAX) ul.removeChild(ul.lastChild);
}

// ── Cash-out feedback ────────────────────────────────────────────────

function flashCashout(slot, profit) {
  const btn = $(`#cashout-${slot}`);
  if (!btn) return;
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 420);

  // Floating "+X.XX" text above the bet panel.
  const slotEl = btn.closest('.bet-slot');
  const rect = slotEl.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'floater';
  f.textContent = `+${profit.toFixed(2)}`;
  f.style.left = `${rect.left + rect.width / 2 - 30}px`;
  f.style.top  = `${rect.top - 8}px`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1400);
}

// ── Wiring: bet panel controls ───────────────────────────────────────

function getAutoCashoutInput(slot) {
  const on = $(`#ac-on-${slot}`).checked;
  if (!on) return null;
  const v = parseFloat($(`#ac-val-${slot}`).value);
  if (!isFinite(v) || v <= 1) return null;
  return v;
}

for (const slot of ['A', 'B']) {
  $(`#place-${slot}`).addEventListener('click', () => {
    const stake = parseInt($(`#stake-${slot}`).value, 10);
    if (!isFinite(stake) || stake < 1) return;
    send({ type: 'place_bet', slot, stake, autoCashout: getAutoCashoutInput(slot) });
  });
  $(`#cashout-${slot}`).addEventListener('click', () => {
    send({ type: 'cash_out', slot });
  });
  $(`#stake-${slot}`).addEventListener('input', () => renderBets());

  $$(`button[data-stake-step="${slot}"]`).forEach((b) => {
    b.addEventListener('click', () => {
      const cur = parseInt($(`#stake-${slot}`).value, 10) || 1;
      const m = parseFloat(b.dataset.mult);
      const next = Math.max(1, Math.min(500, Math.round(cur * m)));
      $(`#stake-${slot}`).value = next;
      renderBets();
    });
  });

  $$(`[data-presets="${slot}"] button[data-preset]`).forEach((b) => {
    b.addEventListener('click', () => {
      $(`#stake-${slot}`).value = b.dataset.preset;
      renderBets();
    });
  });

  $(`#ab-on-${slot}`).addEventListener('change', (e) => {
    const enabled = e.target.checked;
    if (enabled) {
      const stake = parseInt($(`#stake-${slot}`).value, 10) || 1;
      send({ type: 'set_autobet', slot, enabled: true, stake, autoCashout: getAutoCashoutInput(slot) });
    } else {
      send({ type: 'set_autobet', slot, enabled: false });
    }
  });
}

// ── Provably-fair UI ─────────────────────────────────────────────────

// ── Operator P&L modal ──────────────────────────────────────────────

function fmtMoney(n)   { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtMoneyK(n)  {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(v) >= 10_000)    return (v / 1_000).toFixed(1) + 'K';
  return fmtMoney(v);
}
function fmtPct(x)     { return (x * 100).toFixed(2) + '%'; }
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`;
}

function renderHouseModal() {
  const snap = state.operator;
  if (!snap) return;
  const { cumulative: c, lastRound: lr } = snap;

  $('#op-rounds').textContent  = c.rounds.toLocaleString();
  $('#op-elapsed').textContent = fmtDuration(c.sessionMs);
  $('#op-wagered').textContent = fmtMoney(c.wagered);
  $('#op-paid').textContent    = fmtMoney(c.paidOut);
  const ggrEl = $('#op-ggr');
  ggrEl.textContent = fmtMoney(c.ggr);
  ggrEl.classList.toggle('positive', c.ggr >= 0);
  ggrEl.classList.toggle('negative', c.ggr <  0);
  $('#op-edge').textContent    = c.wagered > 0 ? fmtPct(c.houseEdge) : '—';
  $('#op-rtp').textContent     = c.wagered > 0 ? fmtPct(c.rtp)       : '—';
  $('#op-avgbet').textContent  = c.rounds > 0 ? fmtMoney(c.wagered / c.rounds) : '0.00';

  if (lr) {
    $('#op-last-crash').textContent = `${lr.crashPoint.toFixed(2)}x${lr.escaped ? ' (escaped)' : ''}`;
    $('#op-last-bet').textContent   = fmtMoney(lr.wagered);
    $('#op-last-paid').textContent  = fmtMoney(lr.paidOut);
    const last = $('#op-last-ggr');
    last.textContent = fmtMoney(lr.ggr);
    last.classList.toggle('positive', lr.ggr >= 0);
    last.classList.toggle('negative', lr.ggr <  0);
  }

  renderForecast();
}

function renderForecast() {
  const snap = state.operator;
  if (!snap) return;
  const c = snap.cumulative;

  const players = Math.max(1, parseFloat($('#calc-players').value)  || 0);
  const bet     = Math.max(0, parseFloat($('#calc-bet').value)      || 0);
  const slots   = Math.max(0.1, parseFloat($('#calc-slots').value)  || 0);
  const hours   = Math.max(1, parseFloat($('#calc-hours').value)    || 0);

  // Round rate observed in the live session — falls back to a known
  // genre baseline (5s betting + ~15s flying + 3s crash ≈ 23s/round)
  // until we have enough samples for a reliable empirical rate.
  let roundsPerHour;
  if (c.rounds >= 3 && c.sessionMs > 0) {
    roundsPerHour = (c.rounds / (c.sessionMs / 1000)) * 3600;
  } else {
    roundsPerHour = 3600 / 23;
  }

  // Realized house edge — fallback to design target until we have data.
  const edge = c.wagered > 0 ? c.houseEdge : 0.03;

  const betsPerRound  = players * slots;
  const wagerPerRound = betsPerRound * bet;
  const wagerPerHour  = wagerPerRound * roundsPerHour;
  const revPerHour    = wagerPerHour * edge;
  const revPerDay     = revPerHour * hours;
  const revPerMonth   = revPerDay * 30;

  $('#fc-rounds-hr').textContent = Math.round(roundsPerHour).toLocaleString();
  $('#fc-wager-hr').textContent  = '$' + fmtMoneyK(wagerPerHour);
  $('#fc-rev-hr').textContent    = '$' + fmtMoneyK(revPerHour);
  $('#fc-rev-day').textContent   = '$' + fmtMoneyK(revPerDay);
  $('#fc-rev-month').textContent = '$' + fmtMoneyK(revPerMonth);
}

$('#open-house').addEventListener('click', () => {
  renderHouseModal();
  $('#house-modal').hidden = false;
});
$('#close-house').addEventListener('click', () => closeModal($('#house-modal')));
$('#house-modal').addEventListener('click', (e) => {
  if (e.target === $('#house-modal')) closeModal($('#house-modal'));
});
for (const id of ['calc-players', 'calc-bet', 'calc-slots', 'calc-hours']) {
  $('#' + id).addEventListener('input', renderForecast);
}

$('#open-fair').addEventListener('click', () => {
  populateFairModal();
  $('#fair-modal').hidden = false;
});

function closeModal(modal) { modal.hidden = true; }

// X-button closes
$('#close-fair').addEventListener('click', () => closeModal($('#fair-modal')));
$('#close-chip').addEventListener('click', () => closeModal($('#chip-modal')));

// Click on the dark backdrop (anywhere outside the card) dismisses.
for (const m of [$('#fair-modal'), $('#chip-modal')]) {
  m.addEventListener('click', (e) => {
    if (e.target === m) closeModal(m);
  });
}

// ESC dismisses the topmost open modal (chip first since it stacks above).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const chip  = $('#chip-modal');
  const fair  = $('#fair-modal');
  const house = $('#house-modal');
  if (!chip.hidden) closeModal(chip);
  else if (!fair.hidden)  closeModal(fair);
  else if (!house.hidden) closeModal(house);
});

$('#verify-last').addEventListener('click', async () => {
  const last = state.history[0];
  if (!last) return;
  const out = await verifyRound(last);
  const el = $('#verify-out');
  el.hidden = false;
  el.textContent = out;
});

$('#verify-chip').addEventListener('click', async () => {
  const round = $('#chip-modal')._round;
  if (!round) return;
  const out = await verifyRound(round);
  const el = $('#verify-chip-out');
  el.hidden = false;
  el.textContent = out;
});

function populateFairModal() {
  const c = state.commitment;
  if (c) {
    $('#fair-cur-nonce').textContent = c.nonce ?? '—';
    $('#fair-cur-hash').textContent  = c.serverSeedHash ?? '—';
    $('#fair-cur-cseed').textContent = c.clientSeed ?? '—';
  }
  const last = state.history[0];
  if (last) {
    $('#fair-last-nonce').textContent = last.nonce;
    $('#fair-last-sseed').textContent = last.serverSeed;
    $('#fair-last-hash').textContent  = last.serverSeedHash;
    $('#fair-last-cseed').textContent = last.clientSeed;
    $('#fair-last-crash').textContent = `${last.crashPoint.toFixed(2)}x${last.escaped ? ' (escaped)' : ''}`;
  }
  $('#verify-out').hidden = true;
  $('#verify-out').textContent = '';
}

function showChipDetail(round) {
  const kv = $('#chip-kv');
  kv.replaceChildren();
  const rows = [
    ['Nonce', round.nonce],
    ['Crash', `${round.crashPoint.toFixed(2)}x${round.escaped ? ' (escaped)' : ''}`],
    ['Server seed', round.serverSeed],
    ['Server seed hash', round.serverSeedHash],
    ['Client seed', round.clientSeed],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.className = 'mono break'; dd.textContent = v;
    kv.append(dt, dd);
  }
  $('#chip-modal')._round = round;
  $('#verify-chip-out').hidden = true;
  $('#verify-chip-out').textContent = '';
  $('#chip-modal').hidden = false;
}

// ── Provably-fair verification (mirrors server/crash.js exactly) ─────

async function hmacSha256Hex(keyStr, msgStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msgStr));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyRound(r) {
  const lines = [];
  lines.push(`Round nonce: ${r.nonce}`);
  lines.push(`Stored crash: ${r.crashPoint.toFixed(2)}x`);
  lines.push('');
  // 1) Hash check
  const hash = await sha256Hex(r.serverSeed);
  lines.push(`SHA-256(serverSeed) = ${hash}`);
  lines.push(`Stored hash        = ${r.serverSeedHash}`);
  lines.push(`Hash matches commit: ${hash === r.serverSeedHash ? 'YES' : 'NO'}`);
  lines.push('');
  // 2) HMAC recompute
  const hmacHex = await hmacSha256Hex(r.serverSeed, `${r.clientSeed}:${r.nonce}`);
  lines.push(`HMAC-SHA256(serverSeed, clientSeed + ":" + nonce):`);
  lines.push(`  = ${hmacHex}`);
  const first8 = hmacHex.slice(0, 8);
  const intVal = parseInt(first8, 16);
  const h = intVal / 0x100000000;
  lines.push(`First 8 hex = ${first8}  → uint32 = ${intVal}`);
  lines.push(`h = uint32 / 2^32 = ${h.toFixed(10)}`);
  // 3) Crash formula
  const raw = Math.floor(97 / (1 - h)) / 100;
  const crash = Math.max(1.00, raw);
  lines.push(`crash = max(1.00, floor(97/(1-h))/100) = ${crash.toFixed(2)}x`);
  lines.push('');
  lines.push(`Recomputed crash matches stored: ${Math.abs(crash - r.crashPoint) < 1e-9 ? 'YES ✓' : 'NO ✗'}`);
  return lines.join('\n');
}

// ── Render loop (60fps) ──────────────────────────────────────────────

const scene = createScene($('#scene'));
let lastMilestoneCrossed = 0;

function maybeMilestonePulse(m) {
  const milestones = [2, 5, 10, 25, 50, 100];
  let crossed = 0;
  for (const ms of milestones) if (m >= ms) crossed = ms; else break;
  if (crossed > lastMilestoneCrossed) {
    lastMilestoneCrossed = crossed;
    const el = $('#multiplier');
    el.classList.remove('pulse');
    void el.offsetWidth; // restart animation
    el.classList.add('pulse');
  }
}

// Must match server/game.js GROWTH. Genre-standard 1.07/s pacing
// (Aviator / JetX reference). Update both places if changed.
const GROWTH = 1.07;

function renderLoop() {
  // Smoothly interpolate the multiplier between server ticks for flicker-free read.
  if (state.phase === 'flying' && state.lastTickMs) {
    const sinceTick = performance.now() - state.lastTickMs;
    const projectedElapsed = state.lastTickElapsedMs + sinceTick;
    const t = projectedElapsed / 1000;
    state.multiplier = Math.max(1.00, Math.pow(GROWTH, t));
  }
  if (state.phase === 'crash') {
    state.crashElapsed = Date.now() + state.serverClockSkew - state.phaseStartedAt;
  }

  const m = state.multiplier;
  const mult = m.toFixed(2);
  const mEl = $('#multiplier');
  if (state.phase === 'crash') {
    mEl.textContent = state.crashEscaped
      ? `ESCAPED @ ${mult}x`
      : `CRASHED @ ${mult}x`;
  } else {
    mEl.textContent = `${mult}x`;
  }

  // Betting countdown sub-label + bottom bar.
  const cdEl  = $('#countdown');
  const cdBar = $('#countdown-bar');
  if (state.phase === 'betting') {
    const total = Math.max(1, state.phaseEndsAt - state.phaseStartedAt);
    const remaining = Math.max(0, state.phaseEndsAt - (Date.now() + state.serverClockSkew));
    $('#phase-sub').textContent = `Round starts in ${(remaining / 1000).toFixed(1)}s`;
    cdEl.hidden = false;
    cdBar.style.transform = `scaleX(${remaining / total})`;
    lastMilestoneCrossed = 0; // reset milestone tracker for next round
  } else {
    if (performance.now() < lastResultUntil) {
      $('#phase-sub').textContent = lastResultText;
    } else {
      $('#phase-sub').textContent = '';
    }
    cdEl.hidden = true;
  }

  if (state.phase === 'flying') maybeMilestonePulse(m);

  // Update PLACED slot status in real time so the player sees "stake × m" climbing.
  if (state.phase === 'flying') renderBets();

  // Draw the canvas.
  scene.render({
    phase: state.phase === 'crash' && state.crashEscaped ? 'crash_escape' : state.phase,
    multiplier: m,
    crashElapsed: state.crashElapsed,
    escaped: state.crashEscaped,
  });

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

connect();
