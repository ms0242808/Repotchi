'use strict';

/**
 * What the pet is doing right now, as distinct from how it feels. Mood comes
 * from vitals; behaviour layers short-lived reactions and slow idle habits on
 * top, so the creature does something other than blink between meals.
 */

const REACTION_MS = 1400;
const EVOLUTION_MS = 3600;
const IDLE_WINDOW_MS = 6000;

/** Faces that override the mood face for the duration of a reaction. */
const REACTIONS = {
  eat: [{ l: '>', r: '<', m: 'O' }, { l: '>', r: '<', m: 'w' }],
  play: [{ l: '^', r: '^', m: 'D' }, { l: '>', r: '<', m: 'D' }],
  sleep: [{ l: '-', r: '-', m: 'o' }, { l: '-', r: '-', m: '~' }],
  wake: [{ l: 'O', r: 'O', m: 'o' }, { l: 'o', r: 'o', m: '-' }],
  pet: [{ l: '^', r: '^', m: 'w' }],
  hatch: [{ l: 'O', r: 'O', m: 'o' }, { l: '^', r: '^', m: 'w' }],
  // Refusals get a face too, so no keypress is answered by text alone.
  full: [{ l: '=', r: '=', m: 'o' }, { l: '=', r: '=', m: '-' }],
  tired: [{ l: '-', r: '-', m: 'o' }, { l: '-', r: '-', m: '.' }],
};

/**
 * Idle habits, chosen per six-second window from a deterministic hash so the
 * same instant always looks the same. `weight` is relative frequency; `when`
 * gates by mood or hour.
 */
const IDLE = [
  { id: 'rest', weight: 10, face: null },
  { id: 'glance-left', weight: 3, face: { l: '.', r: 'o' }, when: (m) => m !== 'sleeping' },
  { id: 'glance-right', weight: 3, face: { l: 'o', r: '.' }, when: (m) => m !== 'sleeping' },
  { id: 'squint', weight: 2, face: { l: '=', r: '=' }, when: (m) => m === 'content' || m === 'happy' },
  { id: 'yawn', weight: 4, face: { l: '-', r: '-', m: 'O' }, when: (m, h) => h >= 22 || h < 6 },
  { id: 'perk', weight: 3, face: { l: 'O', r: 'O', m: 'w' }, when: (m, h) => h >= 6 && h < 10 && m !== 'sleeping' },
  { id: 'hum', weight: 2, face: { m: '~' }, when: (m) => m === 'happy' || m === 'ecstatic' },
  { id: 'droop', weight: 4, face: { l: 'u', r: 'u', m: '.' }, when: (m) => m === 'hungry' || m === 'sad' },
  { id: 'wince', weight: 4, face: { l: 'x', r: 'x', m: '~' }, when: (m) => m === 'sick' },
];

function hash(n) {
  const x = Math.sin(n * 91.7) * 10000;
  return x - Math.floor(x);
}

class Behavior {
  constructor() {
    this.reaction = null;
    this.reactionAt = 0;
    this.evolution = null;
  }

  react(kind, now = Date.now()) {
    if (!REACTIONS[kind]) return;
    this.reaction = kind;
    this.reactionAt = now;
  }

  evolve(fromStage, toStage, now = Date.now()) {
    this.evolution = { from: fromStage, to: toStage, at: now };
  }

  /** The stage change in progress, as a 0..1 fraction, or null. */
  evolving(now = Date.now()) {
    if (!this.evolution) return null;
    const t = (now - this.evolution.at) / EVOLUTION_MS;
    if (t >= 1) { this.evolution = null; return null; }
    return { ...this.evolution, t };
  }

  /** Extra bounce to layer on the idle bob while a reaction plays. */
  bounce(now = Date.now()) {
    if (!this.reaction) return 0;
    const t = now - this.reactionAt;
    if (t > REACTION_MS) return 0;
    return (this.reaction === 'play' || this.reaction === 'hatch') && Math.floor(t / 120) % 2 === 0 ? 1 : 0;
  }

  /**
   * Face override for this instant: an active reaction wins, otherwise an idle
   * habit chosen for the current window. Returns partial faces; missing slots
   * fall back to the mood face.
   */
  face(mood, now = Date.now()) {
    if (this.reaction) {
      const t = now - this.reactionAt;
      if (t <= REACTION_MS) {
        const frames = REACTIONS[this.reaction];
        return frames[Math.floor(t / 280) % frames.length];
      }
      this.reaction = null;
    }
    if (mood === 'sleeping') return null;

    const hour = new Date(now).getHours();
    const window = Math.floor(now / IDLE_WINDOW_MS);
    const pool = IDLE.filter((b) => !b.when || b.when(mood, hour));
    const total = pool.reduce((n, b) => n + b.weight, 0);
    let pick = hash(window) * total;
    for (const b of pool) {
      pick -= b.weight;
      if (pick <= 0) {
        // Habits are held for the first two-thirds of the window, then released,
        // so glances read as glances rather than a stuck expression.
        const phase = (now % IDLE_WINDOW_MS) / IDLE_WINDOW_MS;
        return phase < 0.66 ? b.face : null;
      }
    }
    return null;
  }
}

module.exports = { Behavior, REACTIONS, IDLE, REACTION_MS, EVOLUTION_MS };
