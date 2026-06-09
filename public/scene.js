/**
 * Eagle Crash — canvas scene.
 *
 * Renders sky gradient, parallax mountains, motion streaks, hunter, eagle.
 * Driven by a single render(state) call per requestAnimationFrame.
 *
 * Exports a Scene factory. The renderer reads:
 *   state.phase         'betting' | 'flying' | 'crash' | 'crash_escape'
 *   state.multiplier    current visible multiplier
 *   state.crashElapsed  ms since crash phase started (drives the 5 sub-phases)
 *   state.escaped       boolean (true → eagle escapes; false → eagle is shot)
 *
 * Visuals are intentionally geometric (silhouettes) — easy to swap for art later.
 */

const TWO_PI = Math.PI * 2;

export function createScene(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // Layered parallax offsets (advance every frame; speed scales with multiplier).
  const parallax = { near: 0, mid: 0, far: 0, streaks: 0 };

  // Feather puffs spawned at hit time, then physics-stepped each frame.
  let feathers = [];

  // Eagle local state (independent of the multiplier so it can keep flapping during betting too).
  let wingPhase = 0;

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ── Sky gradient evolves with multiplier ─────────────────────────────
  function skyColors(mult) {
    // 1 → calm dawn blue. 5 → midday gold/orange. 25+ → twilight red.
    const t = Math.min(1, Math.log(mult) / Math.log(50));
    const top    = lerpColor([8,14,40],   [70,20,50],  t);
    const middle = lerpColor([26,42,90],  [180,90,60], t);
    const bottom = lerpColor([20,30,70],  [240,140,70], t);
    return { top, middle, bottom };
  }

  function lerpColor(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  const rgb = ([r, g, b]) => `rgb(${r},${g},${b})`;

  // ── Eagle path (silhouette, parametric on wing phase) ────────────────
  function drawEagle(x, y, scale, wingPhaseRad, opts = {}) {
    const { color = '#0c0d15', shot = false, rotation = 0 } = opts;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);
    ctx.fillStyle = shot ? '#000' : color;

    // Body
    ctx.beginPath();
    ctx.ellipse(0, 0, 14, 7, 0, 0, TWO_PI);
    ctx.fill();

    // Head + beak
    ctx.beginPath();
    ctx.ellipse(13, -3, 5, 4, 0, 0, TWO_PI);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(17, -3);
    ctx.lineTo(23, -1);
    ctx.lineTo(17, 0);
    ctx.closePath();
    ctx.fillStyle = '#f3b03d';
    ctx.fill();
    ctx.fillStyle = shot ? '#000' : color;

    // Tail
    ctx.beginPath();
    ctx.moveTo(-12, -1);
    ctx.lineTo(-22, -5);
    ctx.lineTo(-22, 5);
    ctx.closePath();
    ctx.fill();

    // Wings — flap from sin(wingPhase).
    const flap = Math.sin(wingPhaseRad);
    const wingY = -16 + flap * 9;
    const wingTipX = -8;
    // Top wing (upstroke wider)
    ctx.beginPath();
    ctx.moveTo(-2, -3);
    ctx.quadraticCurveTo(wingTipX, wingY - 8, -28, wingY - 4);
    ctx.quadraticCurveTo(-12, -2, -2, -3);
    ctx.fill();
    // Bottom wing (mirrored, slightly delayed)
    const flap2 = Math.sin(wingPhaseRad - 0.6);
    const wingY2 = 16 - flap2 * 9;
    ctx.beginPath();
    ctx.moveTo(-2, 3);
    ctx.quadraticCurveTo(-8, wingY2 + 8, -28, wingY2 + 4);
    ctx.quadraticCurveTo(-12, 2, -2, 3);
    ctx.fill();

    ctx.restore();
  }

  // ── Hunter silhouette (fixed bottom, rotates to track eagle) ─────────
  function drawHunter(x, y, aimAngle, recoil = 0, muzzleFlash = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#06070d';
    // Body
    ctx.beginPath();
    ctx.ellipse(0, 0, 14, 22, 0, 0, TWO_PI);
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.arc(0, -26, 9, 0, TWO_PI);
    ctx.fill();
    // Rifle
    ctx.save();
    ctx.translate(0, -16);
    ctx.rotate(aimAngle);
    ctx.translate(recoil * -3, 0);
    ctx.fillRect(-2, -2, 56, 4);
    ctx.fillRect(-6, -3, 12, 6);
    // Muzzle flash
    if (muzzleFlash > 0) {
      const a = muzzleFlash;
      ctx.translate(56, 0);
      ctx.fillStyle = `rgba(255,238,170,${a})`;
      ctx.beginPath();
      ctx.arc(0, 0, 14 * a, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = `rgba(255,180,90,${a * 0.7})`;
      ctx.beginPath();
      ctx.arc(6, 0, 9 * a, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }

  // ── Mountain silhouettes (3 parallax layers) ─────────────────────────
  function drawMountainLayer(width, height, baseY, peakH, color, offset, seed) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, baseY + peakH);
    const step = 80;
    for (let x = -step; x <= width + step; x += step) {
      const xx = x - (offset % step);
      // Deterministic pseudo-random peak heights per seed.
      const n1 = Math.sin((xx + seed) * 0.013) * 0.5 + 0.5;
      const n2 = Math.sin((xx + seed) * 0.0273) * 0.5 + 0.5;
      const h = baseY - peakH * (0.5 + n1 * 0.5) - n2 * peakH * 0.4;
      ctx.lineTo(xx, h);
    }
    ctx.lineTo(width + step, baseY + peakH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ── Feather particles ────────────────────────────────────────────────
  function spawnFeathers(x, y, count = 14) {
    for (let i = 0; i < count; i++) {
      feathers.push({
        x, y,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 1) * 2,
        age: 0, life: 1.6 + Math.random() * 1.2,
        rot: Math.random() * TWO_PI,
        vr: (Math.random() - 0.5) * 4,
        size: 4 + Math.random() * 5,
      });
    }
  }

  function drawFeathers(dt) {
    feathers = feathers.filter((f) => f.age < f.life);
    for (const f of feathers) {
      f.age += dt;
      f.vy += 0.4 * dt;     // gravity (lighter than the eagle)
      f.vx *= Math.pow(0.985, dt * 60);
      f.x  += f.vx * dt * 60;
      f.y  += f.vy * dt * 60;
      f.rot += f.vr * dt;
      const alpha = Math.max(0, 1 - f.age / f.life);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#cfd2e2';
      ctx.beginPath();
      ctx.ellipse(0, 0, f.size, f.size * 0.35, 0, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }

  function clearFeathers() { feathers = []; }

  // ── Motion streaks ───────────────────────────────────────────────────
  function drawStreaks(width, height, intensity, offset) {
    if (intensity <= 0.01) return;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.10 * intensity})`;
    ctx.lineWidth = 1;
    const lines = 24;
    for (let i = 0; i < lines; i++) {
      const y = (i * (height / lines) + offset) % height;
      const len = 24 + Math.sin(i * 1.3) * 18 + intensity * 50;
      const x = (i * 211 + offset * 0.6) % width;
      ctx.beginPath();
      ctx.moveTo(x + len, y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Public state derived from the game ──────────────────────────────
  let lastFrame = performance.now();
  let crashFlashT = 0;          // 0..1 for muzzle flash
  let screenShake = 0;          // pixels
  let hitTriggered = false;
  let escapeAlpha = 0;

  // Eagle position model: x sweeps left→right while flying;
  // y rises with multiplier; falls during crash sub-phase 3.
  function eagleScreenPos(width, height, mult, phase, crashElapsed) {
    const horizonY = height * 0.72;
    // Y rises smoothly with the multiplier (log curve so it doesn't shoot off).
    const climb = Math.min(1, Math.log(mult) / Math.log(20));
    let y = horizonY - 40 - climb * (height * 0.50);

    let x = width * 0.18 + climb * width * 0.55;
    if (phase === 'betting') {
      // Drift slowly across left edge so it feels alive between rounds.
      x = width * 0.15 + Math.sin(performance.now() * 0.0008) * 10;
      y = horizonY - 80;
    }

    if (phase === 'crash' || phase === 'crash_escape') {
      // After the hit (0.6s in), eagle falls. Before that, freezes mid-flap.
      if (phase === 'crash' && crashElapsed > 600) {
        const tFall = (crashElapsed - 600) / 1400;
        y += tFall * tFall * height * 0.85;
        x += Math.sin(crashElapsed * 0.01) * 30;
      } else if (phase === 'crash_escape') {
        // Soar upward into the clouds
        const tEsc = Math.min(1, crashElapsed / 1500);
        y -= tEsc * height * 0.6;
        x += tEsc * width * 0.15;
      }
    }
    return { x, y };
  }

  function hunterAimAngle(eaglePos, hunterPos) {
    return Math.atan2(eaglePos.y - hunterPos.y, eaglePos.x - hunterPos.x);
  }

  function render(state) {
    const now = performance.now();
    const dt  = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    const width  = canvas.clientWidth;
    const height = canvas.clientHeight;
    const mult   = state.multiplier ?? 1;

    // Wing-beat frequency scales with multiplier (sells speed). 6 Hz base → 18 Hz at 25x.
    const wingHz = state.phase === 'flying'
      ? 6 + Math.min(12, Math.log(mult) * 6)
      : 4;
    wingPhase += dt * TWO_PI * wingHz;

    // Parallax advance — faster as multiplier grows.
    const speed = state.phase === 'flying' ? (60 + mult * 6) : 18;
    parallax.far     += speed * 0.25 * dt;
    parallax.mid     += speed * 0.6  * dt;
    parallax.near    += speed * 1.4  * dt;
    parallax.streaks += speed * 3.0  * dt;

    // Screen shake during the shot.
    const shakeX = (Math.random() - 0.5) * screenShake;
    const shakeY = (Math.random() - 0.5) * screenShake;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    // 1) SKY
    const cols = skyColors(mult);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, rgb(cols.top));
    grad.addColorStop(0.55, rgb(cols.middle));
    grad.addColorStop(1, rgb(cols.bottom));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Soft "sun" halo at the horizon, tinted by sky bottom.
    const sunY = height * 0.65;
    const sun = ctx.createRadialGradient(width * 0.65, sunY, 5, width * 0.65, sunY, height * 0.6);
    sun.addColorStop(0, `rgba(255,230,160,${0.35 + Math.min(0.4, Math.log(mult + 1) * 0.1)})`);
    sun.addColorStop(1, 'rgba(255,230,160,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, width, height);

    // 2) MOTION STREAKS (overlay before mountains so they sit in the sky)
    const streakIntensity = state.phase === 'flying'
      ? Math.min(1, Math.log(mult) * 0.5)
      : 0;
    drawStreaks(width, height, streakIntensity, parallax.streaks);

    // 3) MOUNTAINS — far, mid, near
    drawMountainLayer(width, height, height * 0.72, 90,  '#2a2f55', parallax.far,  100);
    drawMountainLayer(width, height, height * 0.78, 110, '#1a1d3d', parallax.mid,  500);
    drawMountainLayer(width, height, height * 0.86, 130, '#0c0f25', parallax.near, 900);

    // Ground
    ctx.fillStyle = '#06070f';
    ctx.fillRect(0, height * 0.95, width, height * 0.05);

    // 4) HUNTER + EAGLE
    const hunterPos = { x: width * 0.5, y: height * 0.95 - 8 };
    const eaglePos  = eagleScreenPos(width, height, mult, state.phase, state.crashElapsed);

    // Crash sub-phase logic: muzzle flash, shake, hit, fall, aftermath.
    let muzzleFlash = 0;
    let recoil = 0;
    let eagleShot = false;
    let eagleRotation = 0;

    if (state.phase === 'crash') {
      const t = state.crashElapsed;
      if (t < 300) {
        muzzleFlash = 1 - t / 300;
        recoil = (1 - t / 300);
        screenShake = 4 * (1 - t / 300);
      } else {
        screenShake = Math.max(0, screenShake - dt * 50);
      }
      if (t >= 300 && !hitTriggered) {
        hitTriggered = true;
        spawnFeathers(eaglePos.x, eaglePos.y, 18);
      }
      if (t >= 300) eagleShot = true;
      if (t >= 600) {
        // Tumble during fall.
        eagleRotation = ((t - 600) / 1000) * Math.PI * 1.5;
      }
    } else if (state.phase === 'crash_escape') {
      // No shot — eagle soars away. Hunter just lowers weapon.
      screenShake = 0;
      eagleShot = false;
    } else {
      screenShake = Math.max(0, screenShake - dt * 50);
      hitTriggered = false;
    }

    const aim = hunterAimAngle(eaglePos, hunterPos);
    drawHunter(hunterPos.x, hunterPos.y, aim, recoil, muzzleFlash);

    // Eagle. Skip if fell past bottom.
    if (eaglePos.y < height + 60) {
      drawEagle(eaglePos.x, eaglePos.y, 1, wingPhase, {
        shot: eagleShot,
        rotation: eagleRotation,
      });
    }

    // 5) FEATHERS
    drawFeathers(dt);

    // 6) ESCAPE — clouds wash over the top of the screen
    if (state.phase === 'crash_escape') {
      escapeAlpha = Math.min(1, escapeAlpha + dt * 0.7);
      const cloudGrad = ctx.createLinearGradient(0, 0, 0, height * 0.5);
      cloudGrad.addColorStop(0, `rgba(240,240,255,${0.7 * escapeAlpha})`);
      cloudGrad.addColorStop(1, 'rgba(240,240,255,0)');
      ctx.fillStyle = cloudGrad;
      ctx.fillRect(0, 0, width, height * 0.5);
    } else {
      escapeAlpha = Math.max(0, escapeAlpha - dt * 0.5);
    }

    // 7) SLIGHT DARKEN during aftermath of crash
    if (state.phase === 'crash' && state.crashElapsed > 2000) {
      const a = Math.min(0.35, (state.crashElapsed - 2000) / 1000 * 0.35);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.restore();
  }

  return {
    render,
    clearFeathers,
    resize,
  };
}
