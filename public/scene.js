/**
 * Eagle Crash — cinematic canvas scene.
 *
 * Visual strategy:
 *   1. ASSET LAYER (best-case): a CC0 Unsplash mountain panorama loads
 *      asynchronously. While not loaded — and if the load fails — the
 *      procedural sky/mountains underneath keep the scene complete.
 *   2. PROCEDURAL ATMOSPHERE: stars, sun, volumetric clouds, motion
 *      streaks, vignette — all drawn each frame so they evolve with the
 *      multiplier.
 *   3. POST-EFFECTS: lens flare with 5 ghosts + god rays + rim lighting
 *      on the eagle + film grain.
 *   4. CHARACTERS: anatomically tighter eagle silhouette, scoped hunter.
 *   5. TRAIL: the signature glowing curve traced behind the eagle.
 */

const TWO_PI = Math.PI * 2;

// ── Asset loading ─────────────────────────────────────────────────────
// Stable, well-known Unsplash photo IDs. The hash in the URL is the
// content hash so Unsplash returns the SAME image even if it's renamed.
// crossorigin='anonymous' is required to draw them on a canvas without
// tainting it (Unsplash sends the right CORS headers for img.unsplash.com).
const SKY_URLS = [
  // Snow-capped Caucasus-style range at golden hour
  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1800&q=80&auto=format&fit=crop',
  // Backup: alpine sunset
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1800&q=80&auto=format&fit=crop',
];

const assets = {
  bg: null,        // loaded photo (HTMLImageElement) or null
  bgState: 'idle', // 'idle' | 'loading' | 'ready' | 'failed'
};

function tryLoadBackground() {
  if (assets.bgState !== 'idle') return;
  if (typeof Image === 'undefined') { assets.bgState = 'failed'; return; }
  assets.bgState = 'loading';
  let attempt = 0;
  const next = () => {
    if (attempt >= SKY_URLS.length) {
      assets.bgState = 'failed';
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { assets.bg = img; assets.bgState = 'ready'; };
    img.onerror = () => { attempt++; next(); };
    img.src = SKY_URLS[attempt];
  };
  next();
}

// Deterministic pseudo-random for stars / clouds (stable across frames).
function pseudoRand(n) {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

export function createScene(canvas) {
  // Kick off the photo backdrop load on first scene instantiation.
  // Safe to call repeatedly — the function early-returns once started.
  tryLoadBackground();

  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  // Offscreen grain texture (drawn once, sampled with low alpha each frame).
  const grain = makeGrainTexture(256);

  // Stable element arrays
  const stars = [];
  for (let i = 0; i < 110; i++) {
    stars.push({
      x: pseudoRand(i * 12.345),
      y: pseudoRand(i * 91.7 + 17),
      r: 0.6 + pseudoRand(i * 3.3) * 1.8,
      tw: pseudoRand(i * 5.7) * TWO_PI,
    });
  }

  const cloudsFar  = makeCloudBand(10, 0.18);
  const cloudsMid  = makeCloudBand(7,  0.30);
  const cloudsNear = makeCloudBand(5,  0.46);
  function makeCloudBand(n, scale) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        x:    pseudoRand(i * 31 + scale * 100) * 1.5,
        y:    pseudoRand(i * 17 + scale * 200) * 0.55,
        size: 60 + pseudoRand(i * 7 + scale * 31) * 130 * scale * 4,
        density: 5 + Math.floor(pseudoRand(i * 19) * 4),
      });
    }
    return out;
  }

  const parallax = {
    cloudFar: 0, cloudMid: 0, cloudNear: 0,
    mtnFar: 0,   mtnMid: 0,   mtnNear: 0,
    streaks: 0,  stars: 0,
  };

  // Trail (signature curve)
  let trail = [];
  const TRAIL_MAX = 280;

  // Feather particles
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

  // ── Helpers ─────────────────────────────────────────────────────────
  function makeGrainTexture(size) {
    const off = document.createElement('canvas');
    off.width = off.height = size;
    const g = off.getContext('2d');
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
      img.data[i + 3] = 22;        // very low alpha; layered in via multiply
    }
    g.putImageData(img, 0, 0);
    return off;
  }

  // Sky palette: dawn blue → midday gold → twilight red
  function skyPalette(mult) {
    const t = Math.min(1, Math.log(Math.max(1, mult)) / Math.log(60));
    const top    = lerp3([10, 16, 48],  [60, 28, 70],   [22, 8, 42],   t);
    const middle = lerp3([34, 52, 110], [200, 110, 70], [80, 28, 56],  t);
    const bottom = lerp3([28, 40, 90],  [240, 150, 80], [120, 50, 70], t);
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

  // ── Eagle (anatomically tighter silhouette) ─────────────────────────
  // Drawn at the origin; caller translates/rotates/scales.
  // We draw it twice in the render loop: once large with rim glow,
  // once normal as silhouette — that produces the rim-light effect.
  function eagleSilhouette(ctx, wingPhaseRad, opts = {}) {
    const { color = '#0a0c18', headWhite = true, beak = '#f3b03d', shot = false } = opts;

    // Wing flap drives both wings; bottom is slightly delayed.
    const flapUp   = Math.sin(wingPhaseRad);
    const flapDown = Math.sin(wingPhaseRad - 0.55);

    ctx.fillStyle = color;

    // Upper wing — broader, slightly fingered at the tip
    ctx.beginPath();
    ctx.moveTo(-1, -3);
    ctx.bezierCurveTo(-14, -10 - flapUp * 7, -34, -19 - flapUp * 16, -46, -10 - flapUp * 16);
    // wing tip "fingers"
    ctx.lineTo(-50, -7 - flapUp * 14);
    ctx.lineTo(-44, -6 - flapUp * 12);
    ctx.lineTo(-46, -3 - flapUp * 11);
    ctx.lineTo(-40, -2 - flapUp * 9);
    ctx.bezierCurveTo(-24, -2 - flapUp * 4, -10, -2, -1, -3);
    ctx.closePath();
    ctx.fill();

    // Lower wing — mirror with phase delay
    ctx.beginPath();
    ctx.moveTo(-1, 3);
    ctx.bezierCurveTo(-14, 10 + flapDown * 7, -34, 19 + flapDown * 16, -46, 10 + flapDown * 16);
    ctx.lineTo(-50, 7 + flapDown * 14);
    ctx.lineTo(-44, 6 + flapDown * 12);
    ctx.lineTo(-46, 3 + flapDown * 11);
    ctx.lineTo(-40, 2 + flapDown * 9);
    ctx.bezierCurveTo(-24, 2 + flapDown * 4, -10, 2, -1, 3);
    ctx.closePath();
    ctx.fill();

    // Body (slender torpedo)
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 7, 0, 0, TWO_PI);
    ctx.fill();

    // Tail fan
    ctx.beginPath();
    ctx.moveTo(-13, -2);
    ctx.lineTo(-30, -8);
    ctx.lineTo(-34, -2);
    ctx.lineTo(-34, 2);
    ctx.lineTo(-30, 8);
    ctx.lineTo(-13, 2);
    ctx.closePath();
    ctx.fill();

    // Head
    ctx.beginPath();
    ctx.ellipse(14, -3, 7, 5.5, 0, 0, TWO_PI);
    ctx.fill();

    // White crown (bald eagle motif)
    if (headWhite && !shot) {
      ctx.fillStyle = '#eef0f8';
      ctx.beginPath();
      ctx.ellipse(15, -5, 6, 3.2, 0, 0, TWO_PI);
      ctx.fill();
    }

    // Hooked beak
    ctx.fillStyle = shot ? '#222' : beak;
    ctx.beginPath();
    ctx.moveTo(20, -4);
    ctx.lineTo(29, -3);
    ctx.lineTo(26, -1);
    ctx.lineTo(20, -2);
    ctx.closePath();
    ctx.fill();

    if (!shot) {
      // Eye dot
      ctx.fillStyle = '#1a1300';
      ctx.beginPath();
      ctx.arc(16, -5, 1.2, 0, TWO_PI);
      ctx.fill();
    }
  }

  // Draw eagle with optional rim lighting (sun-facing edge in warm tone).
  function drawEagle(x, y, scale, wingPhaseRad, opts = {}) {
    const { rimLight = null, rotation = 0, shot = false } = opts;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scale, scale);

    // Soft shadow blob beneath the eagle for grounding
    ctx.save();
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, 0, 56, 14, 0, 0, TWO_PI);
    ctx.fill();
    ctx.restore();

    // Rim light: draw an enlarged, offset, warm-colored eagle behind the
    // black silhouette. The sun direction is approximately top-right.
    if (rimLight && !shot) {
      const dx =  3, dy = -3;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.scale(1.08, 1.08);
      ctx.shadowColor = rimLight;
      ctx.shadowBlur  = 22;
      eagleSilhouette(ctx, wingPhaseRad, { color: rimLight, headWhite: false, beak: rimLight });
      ctx.restore();
    }

    // Silhouette
    eagleSilhouette(ctx, wingPhaseRad, { color: shot ? '#04050d' : '#0a0c18', shot });
    ctx.restore();
  }

  // ── Hunter ──────────────────────────────────────────────────────────
  function drawHunter(x, y, aimAngle, recoil = 0, muzzleFlash = 0) {
    ctx.save();
    ctx.translate(x, y);
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.50)';
    ctx.beginPath();
    ctx.ellipse(0, 2, 24, 5, 0, 0, TWO_PI);
    ctx.fill();

    ctx.fillStyle = '#04050d';

    // Legs (stance, slight crouch)
    ctx.beginPath();
    ctx.moveTo(-9, 0);  ctx.lineTo(-5, -22); ctx.lineTo(0, -22); ctx.lineTo(-5, 0);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(2, 0);   ctx.lineTo(8, -22);  ctx.lineTo(13, -22); ctx.lineTo(7, 0);
    ctx.closePath(); ctx.fill();

    // Boots
    ctx.fillRect(-10, -2, 10, 4);
    ctx.fillRect(  3, -2, 12, 4);

    // Torso (jacket)
    ctx.fillStyle = '#0a0d1c';
    ctx.beginPath();
    ctx.ellipse(0, -32, 15, 19, 0, 0, TWO_PI);
    ctx.fill();
    // Jacket trim
    ctx.fillStyle = '#181c33';
    ctx.fillRect(-12, -28, 24, 2);

    // Head + hat brim + crown
    ctx.fillStyle = '#06080f';
    ctx.beginPath();
    ctx.arc(0, -55, 9, 0, TWO_PI);
    ctx.fill();
    ctx.fillRect(-14, -49, 28, 3);                  // brim
    ctx.fillRect( -9, -64, 18, 5);                  // crown

    // Rifle (rotates to track eagle, with light recoil)
    ctx.save();
    ctx.translate(0, -38);
    ctx.rotate(aimAngle);
    ctx.translate(recoil * -3, 0);

    // Stock + grip
    ctx.fillStyle = '#262a3e';
    ctx.beginPath();
    ctx.moveTo(-14, -3); ctx.lineTo(2, -3); ctx.lineTo(4, 3); ctx.lineTo(-12, 3);
    ctx.closePath(); ctx.fill();

    // Barrel
    ctx.fillStyle = '#06070d';
    ctx.fillRect(4, -2, 56, 4);
    // Foregrip
    ctx.fillRect(28, -4, 6, 8);
    // Scope
    ctx.fillStyle = '#0d0f1d';
    ctx.fillRect(6, -8, 16, 5);
    ctx.fillStyle = '#262a3e';
    ctx.fillRect(20, -7, 2, 3);

    // Muzzle flash (multi-layer cinematic)
    if (muzzleFlash > 0) {
      const a = muzzleFlash;
      ctx.translate(60, 0);
      // Outer halo
      const halo = ctx.createRadialGradient(0, 0, 4 * a, 0, 0, 32 * a);
      halo.addColorStop(0,   `rgba(255, 244, 200, ${a * 0.85})`);
      halo.addColorStop(0.5, `rgba(255, 180, 100, ${a * 0.55})`);
      halo.addColorStop(1,   'rgba(255, 120,  40, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(-40, -40, 80, 80);
      // Core
      ctx.fillStyle = `rgba(255, 252, 230, ${a})`;
      ctx.beginPath();
      ctx.arc(0, 0, 11 * a, 0, TWO_PI);
      ctx.fill();
      // Tongue
      ctx.fillStyle = `rgba(255, 200, 100, ${a * 0.9})`;
      ctx.beginPath();
      ctx.moveTo(0, -3 * a);
      ctx.lineTo(22 * a, 0);
      ctx.lineTo(0, 3 * a);
      ctx.closePath();
      ctx.fill();
      // Spark cross
      ctx.strokeStyle = `rgba(255, 250, 220, ${a * 0.8})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-20 * a, 0); ctx.lineTo(20 * a, 0);
      ctx.moveTo(0, -16 * a); ctx.lineTo(0, 16 * a);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
  }

  // ── Mountains ───────────────────────────────────────────────────────
  function drawMountainLayer(width, height, baseY, peakH, color, offset, seed, opts = {}) {
    const { snow = false, rim = null } = opts;
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

    // Rim light along the top edge (warm sun-side glow)
    if (rim) {
      ctx.save();
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = rim;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const [x, y] = path[i];
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (snow) {
      ctx.fillStyle = 'rgba(225, 232, 255, 0.88)';
      for (let i = 1; i < path.length - 1; i++) {
        const [, y0] = path[i - 1];
        const [x1, y1] = path[i];
        const [, y2] = path[i + 1];
        if (y1 < y0 && y1 < y2) {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - 14, y1 + 16);
          ctx.lineTo(x1 + 14, y1 + 16);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // ── Clouds (soft puffs) ─────────────────────────────────────────────
  function drawCloudBand(band, width, height, offset, alpha, tint = '255, 240, 220') {
    const skyH = height * 0.6;
    ctx.save();
    ctx.fillStyle = `rgba(${tint}, ${alpha})`;
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
      const twinkle = 0.55 + 0.45 * Math.sin(s.tw + time * 0.002);
      ctx.fillStyle = `rgba(255, 252, 235, ${alpha * twinkle})`;
      ctx.beginPath();
      ctx.arc(s.x * width, s.y * height * 0.55, s.r, 0, TWO_PI);
      ctx.fill();
    }
    ctx.restore();
  }

  // ── God rays from the sun ───────────────────────────────────────────
  // Cheap implementation: light, semi-transparent rays radiating from the
  // sun position. Looks legit when combined with bloom + lens flare.
  function drawGodRays(sunX, sunY, width, height, intensity) {
    if (intensity <= 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const rays = 20;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TWO_PI + parallax.streaks * 0.003;
      const r = Math.max(width, height) * 1.2;
      const grd = ctx.createLinearGradient(sunX, sunY, sunX + Math.cos(a) * r, sunY + Math.sin(a) * r);
      grd.addColorStop(0,    `rgba(255, 230, 170, ${0.08 * intensity})`);
      grd.addColorStop(0.15, `rgba(255, 200, 130, ${0.04 * intensity})`);
      grd.addColorStop(1,    'rgba(255, 200, 130, 0)');
      ctx.strokeStyle = grd;
      ctx.lineWidth = 60 + Math.sin(i * 1.7) * 30;
      ctx.beginPath();
      ctx.moveTo(sunX, sunY);
      ctx.lineTo(sunX + Math.cos(a) * r, sunY + Math.sin(a) * r);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Lens flare ghosts ───────────────────────────────────────────────
  // Multiple translucent discs along the line from sun → screen center,
  // simulating internal reflections in the lens. Classic cinematic look.
  function drawLensFlare(sunX, sunY, width, height, intensity) {
    if (intensity <= 0.02) return;
    const cx = width / 2;
    const cy = height / 2;
    const dx = cx - sunX;
    const dy = cy - sunY;
    const ghosts = [
      { t: 0.20, r: 30, color: 'rgba(255, 220, 160, 0.30)' },
      { t: 0.45, r: 18, color: 'rgba(180, 220, 255, 0.22)' },
      { t: 0.65, r: 26, color: 'rgba(255, 180, 200, 0.18)' },
      { t: 0.90, r: 42, color: 'rgba(255, 240, 200, 0.22)' },
      { t: 1.15, r: 14, color: 'rgba(180, 220, 255, 0.18)' },
      { t: 1.40, r: 22, color: 'rgba(255, 200, 160, 0.16)' },
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const g of ghosts) {
      const x = sunX + dx * g.t;
      const y = sunY + dy * g.t;
      const grd = ctx.createRadialGradient(x, y, 0, x, y, g.r);
      const baseAlpha = parseFloat(g.color.match(/[\d.]+\)$/)[0]);
      const tinted = g.color.replace(/[\d.]+\)$/, `${baseAlpha * intensity})`);
      grd.addColorStop(0, tinted);
      grd.addColorStop(1, tinted.replace(/[\d.]+\)$/, '0)'));
      ctx.fillStyle = grd;
      ctx.fillRect(x - g.r * 2, y - g.r * 2, g.r * 4, g.r * 4);
    }

    // Anamorphic horizontal streak through the sun
    const streak = ctx.createLinearGradient(0, sunY, width, sunY);
    streak.addColorStop(0,    'rgba(255, 220, 160, 0)');
    streak.addColorStop(0.5,  `rgba(255, 230, 180, ${0.20 * intensity})`);
    streak.addColorStop(1,    'rgba(255, 220, 160, 0)');
    ctx.fillStyle = streak;
    ctx.fillRect(0, sunY - 2, width, 4);
    ctx.restore();
  }

  // ── Feathers ────────────────────────────────────────────────────────
  function spawnFeathers(x, y, count = 22) {
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
  function drawTrail(mult) {
    if (trail.length < 2) return;
    const lineWidth = 2 + Math.min(8, Math.log(mult) * 1.3);
    const t = Math.min(1, Math.log(mult) / Math.log(20));
    const r = Math.round(180 + t * 75);
    const g = Math.round(120 + (1 - t) * 50);
    const b = Math.round(40  + (1 - t) * 60);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Outer glow
    ctx.strokeStyle = `rgba(${r},${g},${b},0.30)`;
    ctx.lineWidth = lineWidth * 4;
    ctx.beginPath();
    ctx.moveTo(trail[0].x, trail[0].y);
    for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
    ctx.stroke();

    // Core
    ctx.strokeStyle = `rgba(${r},${g + 40},${b + 30},0.95)`;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Inner highlight
    ctx.strokeStyle = `rgba(255, 248, 215, 0.65)`;
    ctx.lineWidth = Math.max(1, lineWidth * 0.35);
    ctx.stroke();
    ctx.restore();
  }
  function clearTrail() { trail = []; }

  // ── Eagle position ──────────────────────────────────────────────────
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

    const speed = state.phase === 'flying' ? (50 + mult * 5) : 14;
    parallax.cloudFar  += speed * 0.10 * dt;
    parallax.cloudMid  += speed * 0.22 * dt;
    parallax.cloudNear += speed * 0.45 * dt;
    parallax.mtnFar    += speed * 0.25 * dt;
    parallax.mtnMid    += speed * 0.55 * dt;
    parallax.mtnNear   += speed * 1.25 * dt;
    parallax.streaks   += speed * 3.0  * dt;
    parallax.stars     += dt;

    const wingHz = state.phase === 'flying'
      ? 6 + Math.min(12, Math.log(mult) * 6)
      : 4;
    wingPhase += dt * TWO_PI * wingHz;

    // Crash shake / flash
    let muzzleFlash = 0, recoil = 0;
    if (state.phase === 'crash') {
      const t = state.crashElapsed;
      if (t < 300) {
        muzzleFlash = 1 - t / 300;
        recoil = 1 - t / 300;
        screenShake = 6 * (1 - t / 300);
      } else {
        screenShake = Math.max(0, screenShake - dt * 60);
      }
    } else {
      screenShake = Math.max(0, screenShake - dt * 60);
      if (state.phase !== 'crash' && state.phase !== 'crash_escape') hitTriggered = false;
    }

    const shakeX = (Math.random() - 0.5) * screenShake;
    const shakeY = (Math.random() - 0.5) * screenShake;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    const cols = skyPalette(mult);

    // 1) SKY BACKDROP — photo if loaded, procedural otherwise.
    if (assets.bgState === 'ready' && assets.bg) {
      // cover-fit the image, with slow horizontal drift tied to parallax
      const img = assets.bg;
      const imgAspect = img.naturalWidth / img.naturalHeight;
      const cnvAspect = width / height;
      let drawW, drawH;
      if (imgAspect > cnvAspect) {
        drawH = height;
        drawW = drawH * imgAspect;
      } else {
        drawW = width;
        drawH = drawW / imgAspect;
      }
      const drift = (parallax.mtnFar * 0.4) % (drawW - width);
      const dx = -((drawW - width) / 2) - drift;
      const dy = -((drawH - height) / 2);
      ctx.drawImage(img, dx, dy, drawW, drawH);

      // Color-grade overlay tinted by sky palette — preserves photo detail
      // but pulls hues toward the current "time of day".
      ctx.fillStyle = rgba(cols.middle, 0.28 + cols.t * 0.18);
      ctx.fillRect(0, 0, width, height);
    } else {
      // Procedural sky
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0,    rgb(cols.top));
      grad.addColorStop(0.55, rgb(cols.middle));
      grad.addColorStop(1,    rgb(cols.bottom));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    // 2) STARS — fade in toward twilight
    const starAlpha = Math.max(0, (cols.t - 0.45) * 1.5);
    drawStars(width, height, Math.min(0.9, starAlpha), parallax.stars * 1000);

    // 3) SUN — disc + bloom
    const sunX = width * 0.68;
    const sunY = height * (0.34 + cols.t * 0.12);
    const sunR = 40 + cols.t * 16;
    const sunCore = lerp3([255, 240, 200], [255, 200, 130], [255, 140, 110], cols.t);
    // Bloom
    const bloom = ctx.createRadialGradient(sunX, sunY, sunR * 0.35, sunX, sunY, sunR * 7);
    bloom.addColorStop(0, rgba(sunCore, 0.65));
    bloom.addColorStop(1, rgba(sunCore, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, width, height);
    // Disc
    ctx.fillStyle = rgba(sunCore, 0.95);
    ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, TWO_PI); ctx.fill();

    // 4) GOD RAYS (cheap implementation, looks legit with the bloom)
    drawGodRays(sunX, sunY, width, height, 0.55 + cols.t * 0.35);

    // 5) FAR & MID CLOUDS — drawn behind mountains
    drawCloudBand(cloudsFar, width, height, parallax.cloudFar, 0.20);
    drawCloudBand(cloudsMid, width, height, parallax.cloudMid, 0.30);

    // 6) MOTION STREAKS
    const streakIntensity = state.phase === 'flying'
      ? Math.min(1, Math.log(Math.max(1, mult)) * 0.5)
      : 0;
    drawStreaks(width, height, streakIntensity, parallax.streaks);

    // 7) MOUNTAIN SILHOUETTES (skipped if the photo backdrop is in use,
    //    since the photo already has mountains — we draw just the near
    //    layer as a foreground for depth)
    const rim = rgba(sunCore, 0.55);
    if (assets.bgState !== 'ready') {
      drawMountainLayer(width, height, height * 0.70, 110, '#2c3360', parallax.mtnFar,  100, { snow: true, rim });
      drawMountainLayer(width, height, height * 0.78, 110, '#1b1f44', parallax.mtnMid,  500);
    }
    drawMountainLayer(width, height, height * 0.86, 130, '#0a0d22', parallax.mtnNear, 900);

    // 8) HORIZON HAZE
    const haze = ctx.createLinearGradient(0, height * 0.62, 0, height * 0.82);
    haze.addColorStop(0, rgba(cols.middle, 0));
    haze.addColorStop(1, rgba(cols.middle, 0.50));
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.62, width, height * 0.22);

    // 9) NEAR CLOUDS — in front of mountains
    drawCloudBand(cloudsNear, width, height, parallax.cloudNear, 0.45);

    // 10) GROUND PLATE
    const groundGrad = ctx.createLinearGradient(0, height * 0.92, 0, height);
    groundGrad.addColorStop(0, '#070914');
    groundGrad.addColorStop(1, '#02030a');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, height * 0.93, width, height * 0.07);

    // 11) Eagle position + trail
    const eaglePos  = eagleScreenPos(width, height, mult, state.phase, state.crashElapsed);
    const hunterPos = { x: width * 0.5, y: height * 0.94 };

    if (state.phase === 'flying' || state.phase === 'crash_escape') {
      const last = trail[trail.length - 1];
      if (!last || Math.abs(last.x - eaglePos.x) + Math.abs(last.y - eaglePos.y) > 2) {
        trail.push({ x: eaglePos.x, y: eaglePos.y });
        if (trail.length > TRAIL_MAX) trail.shift();
      }
    }
    drawTrail(mult);

    // 12) Crash hit
    if (state.phase === 'crash' && !hitTriggered && state.crashElapsed >= 300) {
      hitTriggered = true;
      spawnFeathers(eaglePos.x, eaglePos.y, 24);
    }
    let eagleShot = false, eagleRotation = 0;
    if (state.phase === 'crash') {
      if (state.crashElapsed >= 300) eagleShot = true;
      if (state.crashElapsed >= 600) eagleRotation = ((state.crashElapsed - 600) / 1000) * Math.PI * 1.5;
    }

    // 13) HUNTER
    const aim = hunterAimAngle(eaglePos, hunterPos);
    drawHunter(hunterPos.x, hunterPos.y, aim, recoil, muzzleFlash);

    // 14) EAGLE — drawn last (in front), with rim light coming from the sun
    if (eaglePos.y < height + 60) {
      const rimColor = rgba(sunCore, 0.55);
      drawEagle(eaglePos.x, eaglePos.y, 1.1, wingPhase, {
        shot: eagleShot,
        rotation: eagleRotation,
        rimLight: rimColor,
      });
    }

    // 15) FEATHERS
    drawFeathers(dt);

    // 16) ESCAPE WASH
    if (state.phase === 'crash_escape') {
      escapeAlpha = Math.min(1, escapeAlpha + dt * 0.9);
      const cloudGrad = ctx.createLinearGradient(0, 0, 0, height * 0.55);
      cloudGrad.addColorStop(0, `rgba(245, 248, 255, ${0.88 * escapeAlpha})`);
      cloudGrad.addColorStop(1, 'rgba(245, 248, 255, 0)');
      ctx.fillStyle = cloudGrad;
      ctx.fillRect(0, 0, width, height * 0.55);
    } else {
      escapeAlpha = Math.max(0, escapeAlpha - dt * 0.5);
    }

    // 17) AFTERMATH DARKEN
    if (state.phase === 'crash' && state.crashElapsed > 2000) {
      const a = Math.min(0.40, (state.crashElapsed - 2000) / 1000 * 0.40);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(0, 0, width, height);
    }

    // 18) LENS FLARE (drawn over everything for cinematic feel)
    drawLensFlare(sunX, sunY, width, height, 0.6 + cols.t * 0.3);

    // 19) VIGNETTE
    const vg = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35,
                                        width / 2, height / 2, Math.max(width, height) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.48)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, width, height);

    // 20) FILM GRAIN — very subtle, tiled, animated by jittering offset
    ctx.save();
    ctx.globalAlpha = 0.10;
    const gx = (Math.random() * grain.width)  | 0;
    const gy = (Math.random() * grain.height) | 0;
    const pat = ctx.createPattern(grain, 'repeat');
    if (pat) {
      ctx.fillStyle = pat;
      ctx.translate(-gx, -gy);
      ctx.fillRect(gx, gy, width, height);
    }
    ctx.restore();

    ctx.restore();
  }

  return {
    render,
    clearFeathers: () => { feathers = []; },
    clearTrail,
    resize,
  };
}
