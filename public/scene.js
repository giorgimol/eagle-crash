/**
 * Eagle Crash — canvas scene (modern visual pass).
 *
 * Renders a layered cinematic scene:
 *   - star field that fades in at high multipliers (dusk-into-night)
 *   - sky gradient that evolves dawn → midday → twilight as the multiplier climbs
 *   - sun disc with bloom
 *   - 3 parallax cloud layers
 *   - 4-layer mountain silhouettes with snow caps on the back range
 *   - distant haze / fog at the horizon
 *   - motion streaks that intensify with speed
 *   - **TRAIL CURVE** — the iconic crash-game signature: a glowing line
 *     traced behind the eagle's path through the round
 *   - detailed eagle silhouette with broad wings, hooked beak, fanned tail
 *   - hunter with stance + rifle that tracks the eagle
 *   - feather burst + screen shake + gravity tumble at crash
 *   - cloud wash + upward soar at escape
 *
 * State shape (same as before):
 *   state.phase         'betting' | 'flying' | 'crash' | 'crash_escape'
 *   state.multiplier    current visible multiplier
 *   state.crashElapsed  ms since crash phase started
 *   state.escaped       boolean
 */

const TWO_PI = Math.PI * 2;

export function createScene(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // Cumulative parallax offsets
  const parallax = { stars: 0, cloudFar: 0, cloudMid: 0, cloudNear: 0,
                     mtnFar: 0, mtnMid: 0, mtnNear: 0, streaks: 0 };

  // Eagle's traced path (the trail curve). Reset every round.
  let trail = [];
  const TRAIL_MAX = 240;

  // Feather puffs spawned at hit time, then physics-stepped each frame.
  let feathers = [];

  // Deterministic star field (drawn from seed)
  const stars = [];
  for (let i = 0; i < 90; i++) {
    stars.push({
      x: pseudoRand(i * 12.345) ,
      y: pseudoRand(i * 91.7 + 17),
      r: 0.6 + pseudoRand(i * 3.3) * 1.6,
      tw: pseudoRand(i * 5.7) * TWO_PI,
    });
  }
  function pseudoRand(n) {
    // Simple deterministic 0..1
    const s = Math.sin(n) * 43758.5453;
    return s - Math.floor(s);
  }

  // Cloud puffs (deterministic shape, scrolled by parallax)
  const cloudsFar  = makeCloudBand(8, 0.18);
  const cloudsMid  = makeCloudBand(6, 0.28);
  const cloudsNear = makeCloudBand(4, 0.42);
  function makeCloudBand(n, scale) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        x:    pseudoRand(i * 31 + scale * 100) * 1.5,   // 0..1.5 (will be % width)
        y:    pseudoRand(i * 17 + scale * 200) * 0.55,  // 0..0.55 of height (sky region)
        size: 60 + pseudoRand(i * 7 + scale * 31) * 110 * scale * 4,
        density: 4 + Math.floor(pseudoRand(i * 19) * 4),
      });
    }
    return out;
  }

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

  // ── Sky palette ─────────────────────────────────────────────────────
  // Below 1.5x: dawn blue. Around 3-8x: warm gold/orange. Above 15x:
  // deep twilight red with stars visible. The transition is monotonic.
  function skyPalette(mult) {
    const t = Math.min(1, Math.log(Math.max(1, mult)) / Math.log(60));
    // top → middle → bottom
    const top    = lerp3([10, 16, 48],   [60, 24, 70],  [22, 8, 42],   t);
    const middle = lerp3([34, 52, 110],  [200, 110, 70], [80, 28, 56], t);
    const bottom = lerp3([28, 40, 90],   [240, 150, 80], [120, 50, 70], t);
    return { top, middle, bottom, t };
  }
  function lerp3(a, b, c, t) {
    // a → b → c piecewise
    if (t < 0.5) return [
      Math.round(a[0] + (b[0] - a[0]) * (t * 2)),
      Math.round(a[1] + (b[1] - a[1]) * (t * 2)),
      Math.round(a[2] + (b[2] - a[2]) * (t * 2)),
    ];
    const u = (t - 0.5) * 2;
    return [
      Math.round(b[0] + (c[0] - b[0]) * u),
      Math.round(b[1] + (c[1] - b[1]) * u),
      Math.round(b[2] + (c[2] - b[2]) * u),
    ];
  }
  const rgb  = ([r, g, b])    => `rgb(${r},${g},${b})`;
  const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

  // ── Eagle silhouette ───────────────────────────────────────────────
  function drawEagle(x, y, scale, wingPhaseRad, opts = {}) {
    const { shot = false, rotation = 0 } = opts;
    const body = shot ? '#080911' : '#0b0e1c';
    const beak = shot ? '#222' : '#f3b03d';

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);

    // Wing curves — broad, with fingered tips. Phase drives both wings,
    // bottom wing is slightly delayed so the flap reads more avian.
    const flapUp   = Math.sin(wingPhaseRad);
    const flapDown = Math.sin(wingPhaseRad - 0.5);

    // Upper wing
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-2, -2);
    ctx.bezierCurveTo(
      -14, -10 - flapUp * 6,
      -34, -18 - flapUp * 14,
      -42, -8 - flapUp * 14,
    );
    ctx.bezierCurveTo(
      -36, -6 - flapUp * 10,
      -20, -2 - flapUp * 4,
      -2, -2,
    );
    ctx.closePath();
    ctx.fill();

    // Lower wing
    ctx.beginPath();
    ctx.moveTo(-2, 2);
    ctx.bezierCurveTo(
      -14, 10 + flapDown * 6,
      -34, 18 + flapDown * 14,
      -42, 8 + flapDown * 14,
    );
    ctx.bezierCurveTo(
      -36, 6 + flapDown * 10,
      -20, 2 + flapDown * 4,
      -2, 2,
    );
    ctx.closePath();
    ctx.fill();

    // Body (egg-shaped)
    ctx.beginPath();
    ctx.ellipse(0, 0, 14, 7, 0, 0, TWO_PI);
    ctx.fill();

    // Tail fan
    ctx.beginPath();
    ctx.moveTo(-10, -1);
    ctx.lineTo(-26, -7);
    ctx.lineTo(-30, 0);
    ctx.lineTo(-26, 7);
    ctx.closePath();
    ctx.fill();

    // Head — slightly forward, with a white "crown" patch for bald eagle vibe
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(13, -3, 6, 5, 0, 0, TWO_PI);
    ctx.fill();
    if (!shot) {
      ctx.fillStyle = '#e8eaf3';
      ctx.beginPath();
      ctx.ellipse(13, -5, 5, 3, 0, 0, TWO_PI);
      ctx.fill();
    }

    // Hooked beak
    ctx.fillStyle = beak;
    ctx.beginPath();
    ctx.moveTo(18, -4);
    ctx.lineTo(26, -3);
    ctx.lineTo(24, -1);
    ctx.lineTo(18, -2);
    ctx.closePath();
    ctx.fill();

    // Eye (skip if shot)
    if (!shot) {
      ctx.fillStyle = '#1a1300';
      ctx.beginPath();
      ctx.arc(15, -5, 1.2, 0, TWO_PI);
      ctx.fill();
    }

    ctx.restore();
  }

  // ── Hunter ─────────────────────────────────────────────────────────
  function drawHunter(x, y, aimAngle, recoil = 0, muzzleFlash = 0) {
    ctx.save();
    ctx.translate(x, y);
    // Shadow under feet
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, 2, 22, 4, 0, 0, TWO_PI);
    ctx.fill();

    // Legs (slight stance)
    ctx.fillStyle = '#04050d';
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(-5, -22);
    ctx.lineTo(0, -22);
    ctx.lineTo(-5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.lineTo(8, -22);
    ctx.lineTo(13, -22);
    ctx.lineTo(7, 0);
    ctx.closePath();
    ctx.fill();

    // Torso
    ctx.beginPath();
    ctx.ellipse(0, -32, 14, 18, 0, 0, TWO_PI);
    ctx.fill();
    // Head + hat brim
    ctx.beginPath();
    ctx.arc(0, -55, 9, 0, TWO_PI);
    ctx.fill();
    ctx.fillRect(-13, -49, 26, 3);

    // Rifle (rotates to track eagle, with light recoil)
    ctx.save();
    ctx.translate(0, -38);
    ctx.rotate(aimAngle);
    ctx.translate(recoil * -3, 0);
    // Stock
    ctx.fillStyle = '#1a1d2e';
    ctx.fillRect(-10, -3, 18, 6);
    // Barrel
    ctx.fillStyle = '#04050d';
    ctx.fillRect(8, -2, 52, 4);
    // Scope
    ctx.fillStyle = '#0d0f1d';
    ctx.fillRect(2, -7, 14, 4);
    // Muzzle flash
    if (muzzleFlash > 0) {
      const a = muzzleFlash;
      ctx.translate(60, 0);
      // Outer halo
      ctx.fillStyle = `rgba(255, 240, 180, ${a * 0.5})`;
      ctx.beginPath();
      ctx.arc(0, 0, 22 * a, 0, TWO_PI);
      ctx.fill();
      // Core
      ctx.fillStyle = `rgba(255, 248, 220, ${a})`;
      ctx.beginPath();
      ctx.arc(0, 0, 12 * a, 0, TWO_PI);
      ctx.fill();
      // Tongue
      ctx.fillStyle = `rgba(255, 170, 80, ${a * 0.85})`;
      ctx.beginPath();
      ctx.moveTo(0, -3 * a);
      ctx.lineTo(18 * a, 0);
      ctx.lineTo(0, 3 * a);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }

  // ── Mountain silhouettes ───────────────────────────────────────────
  function drawMountainLayer(width, height, baseY, peakH, color, offset, seed, opts = {}) {
    const { snow = false } = opts;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, baseY + peakH);
    const step = 70;
    const path = [];
    for (let x = -step; x <= width + step; x += step) {
      const xx = x - (offset % step);
      const n1 = Math.sin((xx + seed) * 0.013) * 0.5 + 0.5;
      const n2 = Math.sin((xx + seed) * 0.0273) * 0.5 + 0.5;
      const h = baseY - peakH * (0.5 + n1 * 0.5) - n2 * peakH * 0.4;
      ctx.lineTo(xx, h);
      path.push([xx, h]);
    }
    ctx.lineTo(width + step, baseY + peakH);
    ctx.closePath();
    ctx.fill();

    if (snow) {
      // Snow caps — small triangle on each peak.
      ctx.fillStyle = 'rgba(220,230,255,0.85)';
      for (let i = 1; i < path.length - 1; i++) {
        const [x0, y0] = path[i - 1];
        const [x1, y1] = path[i];
        const [x2, y2] = path[i + 1];
        if (y1 < y0 && y1 < y2) {
          // Local peak
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - 12, y1 + 14);
          ctx.lineTo(x1 + 12, y1 + 14);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // ── Clouds (soft round puffs) ───────────────────────────────────────
  function drawCloudBand(band, width, height, offset, alpha) {
    const skyH = height * 0.6;
    ctx.save();
    ctx.fillStyle = `rgba(240, 240, 255, ${alpha})`;
    for (const c of band) {
      const x = (c.x * width - offset) % (width + c.size * 2);
      const drawX = x < -c.size ? x + width + c.size * 2 : x;
      const y = c.y * skyH + 30;
      ctx.beginPath();
      for (let i = 0; i < c.density; i++) {
        const dx = (i - c.density / 2) * c.size * 0.4;
        const dy = (pseudoRand(i + c.size) - 0.5) * c.size * 0.15;
        const r = c.size * (0.35 + pseudoRand(i * 2 + c.size) * 0.35);
        ctx.moveTo(drawX + dx + r, y + dy);
        ctx.arc(drawX + dx, y + dy, r, 0, TWO_PI);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Stars ───────────────────────────────────────────────────────────
  function drawStars(width, height, alpha, time) {
    if (alpha <= 0.02) return;
    ctx.save();
    for (const s of stars) {
      const twinkle = 0.6 + 0.4 * Math.sin(s.tw + time * 0.002);
      ctx.fillStyle = `rgba(255, 252, 235, ${alpha * twinkle})`;
      ctx.beginPath();
      ctx.arc(s.x * width, s.y * height * 0.55, s.r, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Feather particles ──────────────────────────────────────────────
  function spawnFeathers(x, y, count = 18) {
    for (let i = 0; i < count; i++) {
      feathers.push({
        x, y,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 1) * 2.5,
        age: 0, life: 1.6 + Math.random() * 1.2,
        rot: Math.random() * TWO_PI,
        vr: (Math.random() - 0.5) * 5,
        size: 4 + Math.random() * 6,
        color: Math.random() < 0.5 ? '#dde0ee' : '#0d1124',
      });
    }
  }
  function drawFeathers(dt) {
    feathers = feathers.filter((f) => f.age < f.life);
    for (const f of feathers) {
      f.age += dt;
      f.vy += 0.5 * dt;
      f.vx *= Math.pow(0.985, dt * 60);
      f.x  += f.vx * dt * 60;
      f.y  += f.vy * dt * 60;
      f.rot += f.vr * dt;
      const alpha = Math.max(0, 1 - f.age / f.life);
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.ellipse(0, 0, f.size, f.size * 0.35, 0, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }
  function clearFeathers() { feathers = []; }

  // ── Motion streaks ─────────────────────────────────────────────────
  function drawStreaks(width, height, intensity, offset) {
    if (intensity <= 0.01) return;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.10 * intensity})`;
    ctx.lineWidth = 1;
    const lines = 26;
    for (let i = 0; i < lines; i++) {
      const y = (i * (height / lines) + offset * 0.4) % height;
      const len = 30 + Math.sin(i * 1.3) * 18 + intensity * 70;
      const x = (i * 211 + offset * 0.6) % (width + len);
      ctx.beginPath();
      ctx.moveTo(x + len, y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Trail curve (the signature) ─────────────────────────────────────
  // Draws a glowing line through the past N eagle positions. Colour gradient
  // shifts from gold to red as the multiplier grows — so a long run reads
  // visibly "hot". Width also scales with the multiplier.
  function drawTrail(mult) {
    if (trail.length < 2) return;
    const lineWidth = 2 + Math.min(8, Math.log(mult) * 1.3);

    // Color shifts cool → warm → hot
    const t = Math.min(1, Math.log(mult) / Math.log(20));
    const r = Math.round(180 + t * 75);
    const g = Math.round(120 + (1 - t) * 50);
    const b = Math.round(40 + (1 - t) * 60);

    // Outer glow (drawn first, wider, lower alpha)
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(${r},${g},${b},0.25)`;
    ctx.lineWidth = lineWidth * 4;
    ctx.beginPath();
    ctx.moveTo(trail[0].x, trail[0].y);
    for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();

    // Main core stroke
    ctx.strokeStyle = `rgba(${r},${g + 40},${b + 30},0.95)`;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Bright inner highlight
    ctx.strokeStyle = `rgba(255, 245, 200, 0.6)`;
    ctx.lineWidth = Math.max(1, lineWidth * 0.35);
    ctx.stroke();
    ctx.restore();
  }
  function clearTrail() { trail = []; }

  // ── Eagle position model ────────────────────────────────────────────
  function eagleScreenPos(width, height, mult, phase, crashElapsed) {
    const horizonY = height * 0.72;
    const climb = Math.min(1, Math.log(mult) / Math.log(20));
    let y = horizonY - 40 - climb * (height * 0.50);
    let x = width * 0.18 + climb * width * 0.55;

    if (phase === 'betting') {
      x = width * 0.15 + Math.sin(performance.now() * 0.0008) * 12;
      y = horizonY - 80 + Math.sin(performance.now() * 0.0014) * 3;
    }
    if (phase === 'crash') {
      if (crashElapsed > 600) {
        const tFall = (crashElapsed - 600) / 1400;
        y += tFall * tFall * height * 0.85;
        x += Math.sin(crashElapsed * 0.01) * 30;
      }
    } else if (phase === 'crash_escape') {
      const tEsc = Math.min(1, crashElapsed / 1500);
      y -= tEsc * height * 0.6;
      x += tEsc * width * 0.15;
    }
    return { x, y };
  }

  function hunterAimAngle(eaglePos, hunterPos) {
    return Math.atan2(eaglePos.y - hunterPos.y, eaglePos.x - hunterPos.x);
  }

  // ── Render ──────────────────────────────────────────────────────────
  let lastFrame = performance.now();
  let screenShake = 0;
  let hitTriggered = false;
  let escapeAlpha = 0;
  let prevPhase = null;

  function render(state) {
    const now = performance.now();
    const dt  = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    const width  = canvas.clientWidth;
    const height = canvas.clientHeight;
    const mult   = state.multiplier ?? 1;

    // Round transitions: reset the trail when we re-enter betting.
    if (prevPhase !== 'betting' && state.phase === 'betting') {
      clearTrail();
      clearFeathers();
      escapeAlpha = 0;
    }
    prevPhase = state.phase;

    // Parallax advance — speed scales with multiplier during flying.
    const speed = state.phase === 'flying' ? (50 + mult * 5) : 14;
    parallax.cloudFar  += speed * 0.10 * dt;
    parallax.cloudMid  += speed * 0.22 * dt;
    parallax.cloudNear += speed * 0.45 * dt;
    parallax.mtnFar    += speed * 0.25 * dt;
    parallax.mtnMid    += speed * 0.55 * dt;
    parallax.mtnNear   += speed * 1.25 * dt;
    parallax.streaks   += speed * 3.0  * dt;
    parallax.stars     += dt;

    // Wing-beat — faster as multiplier climbs (sells the speed).
    const wingHz = state.phase === 'flying'
      ? 6 + Math.min(12, Math.log(mult) * 6)
      : 4;
    wingPhase += dt * TWO_PI * wingHz;

    // Crash-phase mechanics
    let muzzleFlash = 0, recoil = 0;
    if (state.phase === 'crash') {
      const t = state.crashElapsed;
      if (t < 300) {
        muzzleFlash = 1 - t / 300;
        recoil = (1 - t / 300);
        screenShake = 5 * (1 - t / 300);
      } else {
        screenShake = Math.max(0, screenShake - dt * 60);
      }
    } else {
      screenShake = Math.max(0, screenShake - dt * 60);
      if (state.phase !== 'crash' && state.phase !== 'crash_escape') {
        hitTriggered = false;
      }
    }

    const shakeX = (Math.random() - 0.5) * screenShake;
    const shakeY = (Math.random() - 0.5) * screenShake;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    // 1) SKY
    const cols = skyPalette(mult);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0,    rgb(cols.top));
    grad.addColorStop(0.55, rgb(cols.middle));
    grad.addColorStop(1,    rgb(cols.bottom));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 2) STARS — fade in once the sky tilts toward twilight (cols.t > 0.5)
    const starAlpha = Math.max(0, (cols.t - 0.45) * 1.5);
    drawStars(width, height, Math.min(0.9, starAlpha), parallax.stars * 1000);

    // 3) SUN DISC + bloom (centered in the sun band; shifts color with t)
    const sunX = width * 0.68;
    const sunY = height * (0.36 + cols.t * 0.10);
    const sunR = 38 + cols.t * 14;
    const sunCore = lerp3([255, 240, 200], [255, 200, 130], [255, 140, 110], cols.t);
    // Bloom
    const bloom = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 6);
    bloom.addColorStop(0, rgba(sunCore, 0.55));
    bloom.addColorStop(1, rgba(sunCore, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);
    // Disc
    ctx.fillStyle = rgba(sunCore, 0.92);
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, TWO_PI);
    ctx.fill();

    // 4) FAR CLOUDS (behind mountains)
    drawCloudBand(cloudsFar, width, height, parallax.cloudFar, 0.20);
    drawCloudBand(cloudsMid, width, height, parallax.cloudMid, 0.30);

    // 5) MOTION STREAKS (between cloud bands so they sit in the sky)
    const streakIntensity = state.phase === 'flying'
      ? Math.min(1, Math.log(Math.max(1, mult)) * 0.5)
      : 0;
    drawStreaks(width, height, streakIntensity, parallax.streaks);

    // 6) MOUNTAINS — far (with snow caps) → mid → near
    drawMountainLayer(width, height, height * 0.70, 110, '#2c3360', parallax.mtnFar,  100, { snow: true });
    drawMountainLayer(width, height, height * 0.78, 110, '#1b1f44', parallax.mtnMid,  500);
    drawMountainLayer(width, height, height * 0.86, 130, '#0d1128', parallax.mtnNear, 900);

    // 7) HORIZON HAZE
    const haze = ctx.createLinearGradient(0, height * 0.62, 0, height * 0.80);
    haze.addColorStop(0, rgba(cols.middle, 0));
    haze.addColorStop(1, rgba(cols.middle, 0.45));
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.62, width, height * 0.20);

    // 8) NEAR CLOUDS (in front of mountains, behind the eagle)
    drawCloudBand(cloudsNear, width, height, parallax.cloudNear, 0.45);

    // 9) GROUND
    const groundGrad = ctx.createLinearGradient(0, height * 0.92, 0, height);
    groundGrad.addColorStop(0, '#070914');
    groundGrad.addColorStop(1, '#02030a');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, height * 0.93, width, height * 0.07);

    // 10) Compute eagle position, record into trail.
    const eaglePos  = eagleScreenPos(width, height, mult, state.phase, state.crashElapsed);
    const hunterPos = { x: width * 0.5, y: height * 0.94 };

    if (state.phase === 'flying') {
      const last = trail[trail.length - 1];
      if (!last || Math.abs(last.x - eaglePos.x) + Math.abs(last.y - eaglePos.y) > 2) {
        trail.push({ x: eaglePos.x, y: eaglePos.y });
        if (trail.length > TRAIL_MAX) trail.shift();
      }
    }
    if (state.phase === 'crash_escape') {
      // Keep the trail growing as the eagle escapes — visually arcs up.
      trail.push({ x: eaglePos.x, y: eaglePos.y });
      if (trail.length > TRAIL_MAX) trail.shift();
    }

    // 11) TRAIL — drawn behind the eagle, on top of mountains/clouds.
    drawTrail(mult);

    // 12) HIT trigger (only once per crash)
    if (state.phase === 'crash' && !hitTriggered && state.crashElapsed >= 300) {
      hitTriggered = true;
      spawnFeathers(eaglePos.x, eaglePos.y, 22);
    }
    let eagleShot = false, eagleRotation = 0;
    if (state.phase === 'crash') {
      if (state.crashElapsed >= 300) eagleShot = true;
      if (state.crashElapsed >= 600) {
        eagleRotation = ((state.crashElapsed - 600) / 1000) * Math.PI * 1.5;
      }
    }

    // 13) HUNTER
    const aim = hunterAimAngle(eaglePos, hunterPos);
    drawHunter(hunterPos.x, hunterPos.y, aim, recoil, muzzleFlash);

    // 14) EAGLE
    if (eaglePos.y < height + 60) {
      drawEagle(eaglePos.x, eaglePos.y, 1.05, wingPhase, {
        shot: eagleShot,
        rotation: eagleRotation,
      });
    }

    // 15) FEATHERS (in front of everything except overlays)
    drawFeathers(dt);

    // 16) ESCAPE WASH — clouds bloom from the top as the eagle disappears.
    if (state.phase === 'crash_escape') {
      escapeAlpha = Math.min(1, escapeAlpha + dt * 0.9);
      const cloudGrad = ctx.createLinearGradient(0, 0, 0, height * 0.55);
      cloudGrad.addColorStop(0, `rgba(245, 248, 255, ${0.85 * escapeAlpha})`);
      cloudGrad.addColorStop(1, 'rgba(245, 248, 255, 0)');
      ctx.fillStyle = cloudGrad;
      ctx.fillRect(0, 0, width, height * 0.55);
    } else {
      escapeAlpha = Math.max(0, escapeAlpha - dt * 0.5);
    }

    // 17) AFTERMATH DARKEN — last second of crash
    if (state.phase === 'crash' && state.crashElapsed > 2000) {
      const a = Math.min(0.40, (state.crashElapsed - 2000) / 1000 * 0.40);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(0, 0, width, height);
    }

    // 18) Subtle vignette
    const vg = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35,
                                        width / 2, height / 2, Math.max(width, height) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, width, height);

    ctx.restore();
  }

  return {
    render,
    clearFeathers,
    clearTrail,
    resize,
  };
}
