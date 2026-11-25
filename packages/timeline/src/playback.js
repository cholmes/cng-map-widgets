// @cngeo/timeline -- a playback clock.
//
// It owns nothing but time: `step(1)` is called at a steady rate, and whoever
// supplied it moves the selection. That keeps it testable with a clock moved
// by hand, and usable for anything that advances in steps.

const MIN_SPEED = 0.25;
const MAX_SPEED = 30;
/** With reduced motion asked for, a step a second at most: a change of picture, not an animation. */
const REDUCED_MAX = 1;

/**
 * @param {Object} options
 * @param {(direction: 1|-1|'restart') => boolean|void} options.step
 *   Move one step. Return `false` when it cannot (the end). `'restart'` means go back to the start (looping).
 * @param {() => boolean} [options.ready]  False holds the clock -- the data for the next step is still loading -- without stopping it.
 * @param {number} [options.speed]  Steps a second. Default 4; kept within 0.25..30.
 * @param {boolean} [options.loop]  At the end, start again. Default false.
 * @param {boolean} [options.reducedMotion]  The person has asked for reduced motion: never faster than one step a second.
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]  For tests.
 */
export function createPlayback(options) {
  const step = options.step;
  const ready = options.ready ?? (() => true);
  const reduced = Boolean(options.reducedMotion);
  const T = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), ...options.timers };
  const clamp = (n) => {
    const wanted = Number.isFinite(n) ? n : 4;
    return Math.min(Math.max(wanted, MIN_SPEED), reduced ? REDUCED_MAX : MAX_SPEED);
  };
  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();
  let speed = clamp(options.speed ?? 4);
  let loop = Boolean(options.loop);
  let playing = false;
  let destroyed = false;
  let timer = null;

  const state = () => ({ playing, speed, loop });
  const emit = () => {
    if (!destroyed) for (const fn of [...listeners]) fn(state());
  };
  const interval = () => 1000 / speed;

  function schedule(ms) {
    T.clearTimeout(timer);
    timer = T.setTimeout(tick, ms);
  }

  function stop() {
    T.clearTimeout(timer);
    timer = null;
    if (!playing) return;
    playing = false;
    emit();
  }

  function tick() {
    timer = null;
    if (!playing || destroyed) return;
    if (!ready()) {
      schedule(interval()); // held: look again in a moment
      return;
    }
    let moved;
    try {
      moved = step(1);
    } catch {
      stop();
      return;
    }
    if (moved === false) {
      if (!loop) {
        stop();
        return;
      }
      try {
        step('restart');
      } catch {
        stop();
        return;
      }
      // One beat on the first frame, so the start is seen before it moves on.
      schedule(interval() * 2);
      return;
    }
    schedule(interval());
  }

  return {
    get state() {
      return state();
    },

    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    play() {
      if (destroyed || playing) return;
      playing = true;
      schedule(interval());
      emit();
    },

    pause() {
      stop();
    },

    toggle() {
      if (playing) stop();
      else this.play();
    },

    /** Steps a second. Takes effect at once. */
    setSpeed(stepsPerSecond) {
      if (destroyed) return;
      const next = clamp(stepsPerSecond);
      if (next === speed) return;
      speed = next;
      if (playing) schedule(interval());
      emit();
    },

    setLoop(on) {
      if (destroyed || loop === Boolean(on)) return;
      loop = Boolean(on);
      emit();
    },

    /** Move `n` steps by hand (negative for back). Pauses first. */
    stepBy(n) {
      if (destroyed) return;
      stop();
      const direction = n < 0 ? -1 : 1;
      for (let i = 0; i < Math.abs(Math.trunc(n)); i++) {
        let moved;
        try {
          moved = step(direction);
        } catch {
          return;
        }
        if (moved === false) return;
      }
    },

    destroy() {
      if (destroyed) return;
      T.clearTimeout(timer);
      timer = null;
      playing = false;
      destroyed = true;
      listeners.clear();
    },
  };
}
