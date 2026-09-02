'use strict';

const { TUNING } = require('./config');

const KINDS = {
  levelup: {
    glyphs: ['*', '+', '\u00b7', '\u2726', '\u2727'],
    ascii: ['*', '+', '.', 'x', 'o'],
    colours: ['gold', 'snow', 'pink', 'aqua'],
    count: 26,
    rise: true,
  },
  feast: {
    glyphs: ['\u2665', '*', '\u00b7', '\u2727'],
    ascii: ['<', '*', '.', 'o'],
    colours: ['pink', 'hotRed', 'gold'],
    count: 20,
    rise: true,
  },
  badge: {
    glyphs: ['\u2726', '\u00b7', '*'],
    ascii: ['*', '.', '+'],
    colours: ['gold', 'snow'],
    count: 16,
    rise: true,
  },
  crumbs: {
    glyphs: ['\u00b7', '\u2219', 'o'],
    ascii: ['.', ',', 'o'],
    colours: ['lime', 'gold'],
    count: 10,
    rise: false,
  },
};

/**
 * Deterministic pseudo-random from a seed, so a celebration looks the same on
 * every redraw of the same frame instead of flickering.
 */
function rand(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

class Celebration {
  constructor() {
    this.kind = null;
    this.startedAt = 0;
    this.seed = 0;
  }

  fire(kind, now = Date.now()) {
    if (!KINDS[kind]) return;
    this.kind = kind;
    this.startedAt = now;
    this.seed = Math.floor(now % 100000);
  }

  active(now = Date.now()) {
    return Boolean(this.kind) && now - this.startedAt < TUNING.celebrationMs;
  }

  /**
   * Particle positions for the current instant, as a `row,col` keyed map so the
   * renderer can overlay them without knowing anything about the animation.
   */
  particles(width, height, now = Date.now(), ascii = false) {
    if (!this.active(now)) return new Map();
    const spec = KINDS[this.kind];
    const t = (now - this.startedAt) / TUNING.celebrationMs;
    const chars = ascii ? spec.ascii : spec.glyphs;
    const out = new Map();

    for (let i = 0; i < spec.count; i += 1) {
      const r1 = rand(this.seed + i * 7.1);
      const r2 = rand(this.seed + i * 3.3 + 1);
      const r3 = rand(this.seed + i * 5.7 + 2);
      const delay = r3 * 0.35;
      const life = (t - delay) / (1 - delay);
      if (life <= 0 || life >= 1) continue;

      const col = Math.floor(r1 * width);
      const travel = spec.rise ? (1 - life) : life;
      const row = Math.floor(travel * (height - 1) + r2 * 0.9);
      if (row < 0 || row >= height || col < 0 || col >= width) continue;

      // Fade by thinning the field as the burst ages.
      if (life > 0.75 && r2 > 1 - (life - 0.75) * 3) continue;
      out.set(`${row},${col}`, {
        char: chars[Math.floor(r1 * chars.length) % chars.length],
        colour: spec.colours[Math.floor(r2 * spec.colours.length) % spec.colours.length],
      });
    }
    return out;
  }
}

module.exports = { Celebration, KINDS };
