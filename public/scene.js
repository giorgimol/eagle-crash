/**
 * Eagle Crash — clean scene.
 *
 * Genre minimalism (the Aviator/JetX template):
 *   - Dark gradient sky that warms with the multiplier
 *   - Subtle stars that fade in at higher multipliers
 *   - The HERO: a glowing curve that rises from the bottom-left corner
 *     as the multiplier climbs, exactly tracing the eagle's path
 *   - Small eagle silhouette at the tip of the curve
 *   - Small hunter silhouette anchored at the bottom-center
 *   - Crash: shake + flash + the curve and eagle drop
 *   - Escape: the curve and eagle soar off the top
 *
 * Everything else (photo backdrop, clouds, mountains, sun, lens flare,
 * god rays, film grain, vignette) was removed. The curve is the
 * signature; everything else was visual noise drowning it out.
 */

const TWO_PI = Math.PI * 2;

function pseudoRand(n) {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

export function createScene(canvas) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // Star field — deterministic positions, twinkle phase only.
  const stars = [];
  for (let i = 0; i < 70; i++) {
    stars.push({
      x: pseudoRand(i * 12.345),
      y: pseudoRand(i * 91.7 + 17) * 0.7,  // upper 70% of sky
      r: 0.5 + pseudoRand(i * 3.3) * 1.4,
      tw: pseudoRand(i * 5.7) * TWO_PI,
    });
  }

  // The trail — list of {x, y} the eagle has visited this round.
  let trail = [];
  const TRAIL_MAX = 320;

  let feathers = [];
  let wingPhase = 0;
  let lastFrame = performance.now();
  let screenShake = 0;
  let hitTriggered = false;
  let escapeAlpha = 0;
  let prevPhase = null;

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
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(canvas);
  }

  // ── Sky palette ─────────────────────────────────────────────────────
  function skyPalette(mult) {
    const t = Math.min(1, Math.log(Math.max(1, mult)) / Math.log(40));
    const top    = lerp3([6, 8, 28],    [20, 12, 50],   [40, 8, 36],   t);
    const middle = lerp3([14, 22, 60],  [70, 30, 80],   [110, 28, 60], t);
    const bottom = lerp3([20, 30, 70],  [120, 60, 90],  [150, 50, 70], t);
    return { top, middle, bottom, t };
  }
  function lerp3(a, b, c, t) {
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

  // ── Eagle silhouette — small, clean ─────────────────────────────────
  function drawEagle(x, y, scale, wingPhaseRad, opts = {}) {
    const { shot = false, rotation = 0 } = opts;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);

    const flapUp   = Math.sin(wingPhaseRad);
    const flapDown = Math.sin(wingPhaseRad - 0.55);
    const body = shot ? '#000' : '#0d1130';

    // Upper wing
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.quadraticCurveTo(-10, -8 - flapUp * 8, -22, -4 - flapUp * 12);
    ctx.quadraticCurveTo(-14, -1, 0, -2);
    ctx.closePath();
    ctx.fill();

    // Lower wing
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.quadraticCurveTo(-10, 8 + flapDown * 8, -22, 4 + flapDown * 12);
    ctx.quadraticCurveTo(-14, 1, 0, 2);
    ctx.closePath();
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 4, 0, 0, TWO_PI);
    ctx.fill();

    // Tail
    ctx.beginPath();
    ctx.moveTo(-8, -1);
    ctx.lineTo(-15, -3);
    ctx.lineTo(-15, 3);
    ctx.closePath();
    ctx.fill();

    // Head + beak
    ctx.beginPath();
    ctx.ellipse(8, -2, 4, 3, 0, 0, TWO_PI);
    ctx.fill();
    if (!shot) {
      ctx.fillStyle = '#f3b03d';
      ctx.beginPath();
      ctx.moveTo(11, -2);
      ctx.lineTo(15, -1);
      ctx.lineTo(11, 0);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  // ── Hunter — small silhouette at the bottom edge ────────────────────
  function drawHunter(x, y, aimAngle, recoil = 0, muzzleFlash = 0, scale = 1) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    // Soft ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.40)';
    ctx.beginPath();
    ctx.ellipse(0, 2, 14, 3, 0, 0, TWO_PI);
    ctx.fill();

    ctx.fillStyle = '#06081a';

    // Legs
    ctx.fillRect(-5, -14, 3, 14);
    ctx.fillRect( 2, -14, 3, 14);
    // Torso
    ctx.beginPath();
    ctx.ellipse(0, -22, 8, 11, 0, 0, TWO_PI);
    ctx.fill();
    // Head
    ctx.beginPath();
    ctx.arc(0, -36, 5, 0, TWO_PI);
    ctx.fill();
    // Hat brim
    ctx.fillRect(-8, -32, 16, 2);

    // Rifle
    ctx.save();
    ctx.translate(0, -25);
    ctx.rotate(aimAngle);
    ctx.translate(recoil * -2, 0);
    ctx.fillStyle = '#06081a';
    ctx.fillRect(3, -1.5, 30, 3);
    if (muzzleFlash > 0) {
      const a = muzzleFlash;
      ctx.translate(33, 0);
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 14 * a);
      halo.addColorStop(0, `rgba(255,240,180,${a * 0.9})`);
      halo.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(-14 * a, -14 * a, 28 * a, 28 * a);
    }
    ctx.restore();
    ctx.restore();
  }

  // ── Stars ───────────────────────────────────────────────────────────
  function drawStars(width, height, alpha, time) {
    if (alpha <= 0.02) return;
    ctx.save();
    for (const s of stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(s.tw + time * 0.002);
      ctx.fillStyle = `rgba(255, 252, 235, ${alpha * twinkle})`;
      ctx.beginPath();
      ctx.arc(s.x * width, s.y * height, s.r, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Feathers (kept for the crash hit) ───────────────────────────────
  function spawnFeathers(x, y, count = 14) {
    for (let i = 0; i < count; i++) {
      feathers.push({
        x, y,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 1) * 2,
        age: 0, life: 1.4 + Math.random() * 1.0,
        rot: Math.random() * TWO_PI,
        vr: (Math.random() - 0.5) * 4,
        size: 3 + Math.random() * 4,
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
      ctx.fillStyle = '#cfd2e2';
      ctx.beginPath();
      ctx.ellipse(0, 0, f.size, f.size * 0.35, 0, 0, TWO_PI);
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Trail curve — the signature ─────────────────────────────────────
  // Draws a smooth glowing line from the bottom-left corner along
  // every position the eagle has visited this round.
  function drawTrail(mult) {
    if (trail.length < 2) return;
    const lineWidth = 3 + Math.min(7, Math.log(mult) * 1.4);
    const t = Math.min(1, Math.log(mult) / Math.log(20));
    // Gold → warm orange → hot red as the multiplier climbs.
    const r = Math.round(220 + t * 35);
    const g = Math.round(170 + (1 - t) * 30);
    const b = Math.round(60  + (1 - t) * 50);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const path = new Path2D();
    path.moveTo(trail[0].x, trail[0].y);
    for (let i = 1; i < trail.length; i++) path.lineTo(trail[i].x, trail[i].y);

    // Outer glow
    ctx.strokeStyle = `rgba(${r},${g},${b},0.30)`;
    ctx.lineWidth = lineWidth * 4;
    ctx.stroke(path);

    // Mid bloom
    ctx.strokeStyle = `rgba(${r},${g + 30},${b + 20},0.75)`;
    ctx.lineWidth = lineWidth * 1.7;
    ctx.stroke(path);

    // Core
    ctx.strokeStyle = `rgba(${Math.min(255,r+20)},${Math.min(255,g+50)},${Math.min(255,b+40)},1)`;
    ctx.lineWidth = lineWidth;
    ctx.stroke(path);

    // Bright inner highlight
    ctx.strokeStyle = `rgba(255, 250, 220, 0.85)`;
    ctx.lineWidth = Math.max(1.2, lineWidth * 0.35);
    ctx.stroke(path);
    ctx.restore();
  }
  function clearTrail() { trail = []; }

  // ── Eagle position model ───────────────────────────────────────────
  // The eagle starts at the BOTTOM-LEFT corner and climbs toward the
  // upper-right as the multiplier grows. The trail simply records its
  // path, so the curve naturally rises from the bottom-left edge.
  function eagleScreenPos(width, height, mult, phase, crashElapsed) {
    // Anchor points on the curve. Slight inset so the eagle and trail
    // don't kiss the canvas edge.
    const x0 = width  * 0.08;
    const y0 = height * 0.94;
    const x1 = width  * 0.88;
    const y1 = height * 0.12;

    const climb = Math.min(1, Math.log(Math.max(1, mult)) / Math.log(20));
    let x = x0 + (x1 - x0) * climb;
    // y uses an easing so the curve feels like a true exponential ramp:
    // gentle at first, then accelerating up.
    const ey = climb * climb * (3 - 2 * climb);  // smoothstep
    let y = y0 + (y1 - y0) * ey;

    if (phase === 'betting') {
      // Sit at the start, breathing.
      x = x0 + Math.sin(performance.now() * 0.0008) * 6;
      y = y0 + Math.sin(performance.now() * 0.0014) * 3;
    }
    if (phase === 'crash') {
      if (crashElapsed > 600) {
        const tFall = (crashElapsed - 600) / 1400;
        y += tFall * tFall * height * 0.6;
        x += Math.sin(crashElapsed * 0.01) * 18;
      }
    } else if (phase === 'crash_escape') {
      const tEsc = Math.min(1, crashElapsed / 1500);
      y -= tEsc * height * 0.4;
      x += tEsc * width * 0.10;
    }
    return { x, y };
  }

  function hunterAimAngle(eaglePos, hunterPos) {
    return Math.atan2(eaglePos.y - hunterPos.y, eaglePos.x - hunterPos.x);
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render(state) {
    const now = performance.now();
    const dt  = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    const width  = canvas.clientWidth;
    const height = canvas.clientHeight;
    const mult   = state.multiplier ?? 1;

    if (prevPhase !== 'betting' && state.phase === 'betting') {
      clearTrail();
      feathers = [];
      escapeAlpha = 0;
    }
    prevPhase = state.phase;

    const wingHz = state.phase === 'flying'
      ? 6 + Math.min(10, Math.log(mult) * 5)
      : 4;
    wingPhase += dt * TWO_PI * wingHz;

    // Crash effects
    let muzzleFlash = 0, recoil = 0;
    if (state.phase === 'crash') {
      const t = state.crashElapsed;
      if (t < 300) {
        muzzleFlash = 1 - t / 300;
        recoil = 1 - t / 300;
        screenShake = 5 * (1 - t / 300);
      } else {
        screenShake = Math.max(0, screenShake - dt * 50);
      }
    } else {
      screenShake = Math.max(0, screenShake - dt * 50);
      if (state.phase !== 'crash' && state.phase !== 'crash_escape') hitTriggered = false;
    }

    const shakeX = (Math.random() - 0.5) * screenShake;
    const shakeY = (Math.random() - 0.5) * screenShake;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    const cols = skyPalette(mult);

    // 1) SKY — simple vertical gradient. Color warms with multiplier.
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0,    rgb(cols.top));
    grad.addColorStop(0.65, rgb(cols.middle));
    grad.addColorStop(1,    rgb(cols.bottom));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 2) STARS — fade in at high multipliers
    const starAlpha = Math.max(0, (cols.t - 0.35) * 1.4);
    drawStars(width, height, Math.min(0.85, starAlpha), now);

    // 3) Subtle ground gradient at very bottom to anchor the hunter
    const ground = ctx.createLinearGradient(0, height * 0.85, 0, height);
    ground.addColorStop(0, 'rgba(0, 0, 0, 0)');
    ground.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, width, height);

    // 4) Compute eagle + hunter positions
    const eaglePos  = eagleScreenPos(width, height, mult, state.phase, state.crashElapsed);
    const hunterPos = { x: width * 0.15, y: height * 0.96 };

    // 5) Record the trail: kick off from the bottom-left ANCHOR so the
    //    curve always begins at the corner, not wherever the eagle was
    //    last frame.
    if (state.phase === 'flying') {
      if (trail.length === 0) {
        trail.push({ x: width * 0.08, y: height * 0.94 });
      }
      const last = trail[trail.length - 1];
      if (Math.abs(last.x - eaglePos.x) + Math.abs(last.y - eaglePos.y) > 2) {
        trail.push({ x: eaglePos.x, y: eaglePos.y });
        if (trail.length > TRAIL_MAX) trail.shift();
      }
    }
    if (state.phase === 'crash_escape') {
      trail.push({ x: eaglePos.x, y: eaglePos.y });
      if (trail.length > TRAIL_MAX) trail.shift();
    }

    // 6) TRAIL — drawn before characters so they sit on top
    drawTrail(mult);

    // 7) Crash hit
    if (state.phase === 'crash' && !hitTriggered && state.crashElapsed >= 300) {
      hitTriggered = true;
      spawnFeathers(eaglePos.x, eaglePos.y, 16);
    }
    let eagleShot = false, eagleRotation = 0;
    if (state.phase === 'crash') {
      if (state.crashElapsed >= 300) eagleShot = true;
      if (state.crashElapsed >= 600) eagleRotation = ((state.crashElapsed - 600) / 1000) * Math.PI * 1.5;
    }

    // 8) HUNTER — small, anchored at the bottom-left. Scales gently
    //    based on canvas size but capped so he never dominates.
    const hScale = Math.max(0.7, Math.min(1.1, width / 700));
    const aim = hunterAimAngle(eaglePos, hunterPos);
    drawHunter(hunterPos.x, hunterPos.y, aim, recoil, muzzleFlash, hScale);

    // 9) EAGLE — small at the curve tip, with a soft halo for legibility
    const eScale = Math.max(0.85, Math.min(1.4, width / 600));
    if (eaglePos.y < height + 60) {
      // Soft halo
      const HR = 35 * eScale;
      const halo = ctx.createRadialGradient(eaglePos.x, eaglePos.y, 0, eaglePos.x, eaglePos.y, HR);
      halo.addColorStop(0, 'rgba(255, 220, 160, 0.32)');
      halo.addColorStop(1, 'rgba(255, 220, 160, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = halo;
      ctx.fillRect(eaglePos.x - HR, eaglePos.y - HR, HR * 2, HR * 2);
      ctx.restore();

      drawEagle(eaglePos.x, eaglePos.y, eScale, wingPhase, {
        shot: eagleShot,
        rotation: eagleRotation,
      });
    }

    // 10) FEATHERS
    drawFeathers(dt);

    // 11) ESCAPE WASH — gentle bright wash from the top when the
    //     eagle soars away
    if (state.phase === 'crash_escape') {
      escapeAlpha = Math.min(1, escapeAlpha + dt * 0.9);
      const wash = ctx.createLinearGradient(0, 0, 0, height * 0.45);
      wash.addColorStop(0, `rgba(245, 248, 255, ${0.80 * escapeAlpha})`);
      wash.addColorStop(1, 'rgba(245, 248, 255, 0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, width, height * 0.45);
    } else {
      escapeAlpha = Math.max(0, escapeAlpha - dt * 0.5);
    }

    // 12) AFTERMATH DARKEN — only at the very end of the crash phase
    if (state.phase === 'crash' && state.crashElapsed > 2000) {
      const a = Math.min(0.30, (state.crashElapsed - 2000) / 1000 * 0.30);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.restore();
  }

  return {
    render,
    clearFeathers: () => { feathers = []; },
    clearTrail,
    resize,
  };
}
