/**
 * Tiny disk persistence for the demo.
 *
 * Survives:
 *   - dyno restarts (sleep wake)
 *   - process crashes
 *
 * Does NOT survive:
 *   - Render redeploys (free tier wipes the filesystem each deploy)
 *
 * State file path can be overridden via STATE_FILE env var. Default is
 * <repo>/server/.state/game.json — kept out of git via .gitignore.
 *
 * Saves are debounced (~2s) so a busy run doesn't hammer the disk.
 * Loads are synchronous so the Game constructor sees the snapshot
 * before the first round fires.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DEFAULT_FILE = path.resolve(__dirname, '.state', 'game.json');
const STATE_FILE   = process.env.STATE_FILE || DEFAULT_FILE;

function ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let saveTimer = null;
let pendingPayload = null;

export function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const text = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(text);
    console.log(`[persistence] loaded state from ${STATE_FILE}`);
    return parsed;
  } catch (err) {
    console.warn(`[persistence] load failed: ${err.message}`);
    return null;
  }
}

export function scheduleSave(payload) {
  pendingPayload = payload;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = pendingPayload;
    pendingPayload = null;
    if (!data) return;
    try {
      ensureDir();
      fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), (err) => {
        if (err) console.warn(`[persistence] save failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[persistence] save threw: ${err.message}`);
    }
  }, 2000);
}

// Flush on shutdown so we don't lose the last few rounds.
export function flushSync() {
  if (!pendingPayload) return;
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(pendingPayload, null, 2));
    pendingPayload = null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    console.log('[persistence] flushed on shutdown');
  } catch (err) {
    console.warn(`[persistence] flush failed: ${err.message}`);
  }
}

export const STATE_PATH = STATE_FILE;
