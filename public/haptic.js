/**
 * Tiny haptic feedback helper.
 *
 * Following UX guidelines from ui-ux-pro-max-skill:
 *   "Use haptics for confirmations and important actions.
 *    Don't overuse vibration feedback."
 *
 * navigator.vibrate is supported on Android Chrome + Firefox; iOS Safari
 * silently ignores it (no error). All calls are safe in any browser.
 */

const vib = (pattern) => {
  try { navigator.vibrate?.(pattern); } catch {}
};

export const haptic = {
  // Single soft pulse: bet placed, button confirmed
  light:    () => vib(10),
  // Two-pulse pattern: cash-out success
  success:  () => vib([0, 8, 24, 16]),
  // Sharp single pulse: crash / bust
  warning:  () => vib([0, 28, 40, 28]),
  // Long milestone pulse: ≥25x escape, big-win moment
  milestone:() => vib([0, 12, 30, 12, 30, 18]),
};
