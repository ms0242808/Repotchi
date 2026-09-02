'use strict';

const a = require('./ansi');
const species = require('./species');
const vitals = require('./vitals');
const achievements = require('./achievements');
const { TUNING } = require('./config');

const BOX = {
  uni: { tl: '\u256d', tr: '\u256e', bl: '\u2570', br: '\u256f', h: '\u2500', v: '\u2502', lt: '\u251c', rt: '\u2524' },
  ascii: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', lt: '+', rt: '+' },
};

const BAR = { uni: { on: '\u2588', off: '\u2591' }, ascii: { on: '#', off: '.' } };
const SPARK = {
  uni: [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'],
  ascii: [' ', '.', '.', ':', ':', '-', '=', '+', '#'],
};
// Road markers are narrow Dingbats so the strip cannot shift in any terminal.
const ROAD = {
  uni: { done: '\u2726', here: '\u2739', todo: '\u2727', link: '\u2501', arrow: '\u2192' },
  ascii: { done: '#', here: '@', todo: '.', link: '-', arrow: '->' },
};

const TYPE_COLOR = {
  commit: 'lime', push: 'aqua', merge: 'pink', tag: 'gold', streak: 'sky', level: 'gold', badge: 'pink',
};

/** The body and, more quietly, the frame take the colour of the mood. */
const ART_COLOR = {
  ecstatic: 'pink', happy: 'lime', sick: 'hotRed', sad: 'sky', sleeping: 'gray', hungry: 'gold',
};
const FRAME_COLOR = {
  ecstatic: 'pink', happy: 'lime', sick: 'hotRed', sad: 'sky', hungry: 'gold',
};

/**
 * Frame colours a user can pin. Ten distinct ANSI colours, each rendered dim so
 * the frame stays behind the pet whatever the terminal palette does with them.
 * 'mood' is the default and follows the pet's feelings.
 */
const FRAME_COLORS = {
  red: 'red', green: 'green', yellow: 'yellow', blue: 'blue', magenta: 'magenta',
  cyan: 'cyan', white: 'white', gray: 'gray', pink: 'pink', sky: 'sky',
};
const FRAME_CHOICES = ['mood', ...Object.keys(FRAME_COLORS)];

/** Resolves a frame preference to a palette key; unknown values follow mood. */
function frameFor(mood, pref) {
  if (pref && FRAME_COLORS[pref]) return FRAME_COLORS[pref];
  return FRAME_COLOR[mood] || 'gray';
}

/** Wide enough for the two-column layout to be worth it. */
const WIDE_MIN = 108;

function ratioColor(r) {
  if (r >= 0.6) return 'lime';
  if (r >= 0.3) return 'gold';
  return 'hotRed';
}

function clock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function humanAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function sparkline(values, ascii) {
  const ramp = ascii ? SPARK.ascii : SPARK.uni;
  const peak = Math.max(1, ...values);
  return values.map((v) => {
    if (v <= 0) return ramp[0];
    const idx = Math.max(1, Math.round((v / peak) * (ramp.length - 1)));
    return ramp[idx];
  }).join('');
}

class Canvas {
  constructor({ width, p, ascii, frame }) {
    this.w = width;
    this.inner = width - 2;
    this.p = p;
    this.ascii = Boolean(ascii);
    this.b = ascii ? BOX.ascii : BOX.uni;
    this.bar = ascii ? BAR.ascii : BAR.uni;
    this.ell = ascii ? '.' : '\u2026';
    this.frameColor = frame || 'gray';
    this.lines = [];
  }

  /** The frame is context, not content, so every colour is rendered dim. */
  edge(s) {
    const paint = this.p[this.frameColor] || this.p.gray;
    return this.p.dim(paint(s));
  }

  clip(s, w) {
    return a.clip(s, w, this.ell);
  }

  top(left, right) {
    const { b, p } = this;
    const l = left ? ` ${left} ` : '';
    const r = right ? ` ${right} ` : '';
    const fill = Math.max(0, this.inner - a.width(l) - a.width(r) - 1);
    this.lines.push(this.edge(b.tl + b.h) + p.bold(p.snow(l)) + this.edge(b.h.repeat(fill)) + p.dim(r) + this.edge(b.tr));
    return this;
  }

  sep(label) {
    const { b, p } = this;
    const l = label ? ` ${label} ` : '';
    const fill = Math.max(0, this.inner - a.width(l) - 1);
    this.lines.push(this.edge(b.lt + b.h) + p.dim(l) + this.edge(b.h.repeat(fill) + b.rt));
    return this;
  }

  bottom() {
    const { b } = this;
    this.lines.push(this.edge(b.bl + b.h.repeat(this.inner) + b.br));
    return this;
  }

  row(content = '') {
    const { b } = this;
    const body = a.pad(this.clip(content, this.inner), this.inner);
    this.lines.push(this.edge(b.v) + body + this.edge(b.v));
    return this;
  }

  centered(content) {
    return this.row(a.center(this.clip(content, this.inner), this.inner));
  }

  /** Pads with empty rows so two columns can end on the same line. */
  padTo(height) {
    while (this.lines.length < height) this.row();
    return this;
  }

  gauge(label, value, max, cells, suffix) {
    const r = Math.max(0, Math.min(1, value / max));
    const on = Math.round(r * cells);
    const colour = ratioColor(r);
    const filled = this.p[colour](this.bar.on.repeat(on));
    const empty = this.p.gray(this.bar.off.repeat(cells - on));
    return `${this.p.dim(a.pad(label, 8))}${filled}${empty} ${a.padStart(suffix, 8)}`;
  }

  /** Paints particles into the blank space of a line without disturbing the pet. */
  overlay(plain, rowParticles, colour) {
    if (!rowParticles || !rowParticles.size) return this.p[colour](plain);
    const chars = plain.split('');
    let out = '';
    let run = '';
    for (let i = 0; i < chars.length; i += 1) {
      const hit = rowParticles.get(i);
      if (hit && chars[i] === ' ') {
        if (run) { out += this.p[colour](run); run = ''; }
        out += this.p[hit.colour](hit.char);
      } else {
        run += chars[i];
      }
    }
    if (run) out += this.p[colour](run);
    return out;
  }
}

/**
 * The road strip plus a one-line summary of what comes next. Falls back to a
 * shorter phrasing when the row would not fit.
 */
function roadRow(evo, c) {
  const { p, ascii } = c;
  const g = ascii ? ROAD.ascii : ROAD.uni;
  const link = g.link.repeat(2);
  const strip = evo.road.map((s) => {
    if (s.here) return p.bold(p.gold(g.here));
    return s.reached ? p.lime(g.done) : p.gray(g.todo);
  }).join(p.gray(link));

  let text;
  if (!evo.next) {
    text = `${p.snow(evo.current.name)} ${p.dim('- final form')}`;
  } else {
    const eta = evo.etaDays ? p.dim(` ~${evo.etaDays}d`) : '';
    text = `${p.snow(evo.current.name)} ${p.dim(g.arrow)} ${p.gold(evo.next.name)} ${p.dim('in')} ${p.snow(`${evo.xpToNext}xp`)}${eta}`;
  }
  const full = ` ${p.dim(a.pad('road', 8))}${strip}   ${text}`;
  if (a.width(full) <= c.inner) return full;

  const short = evo.next
    ? ` ${strip}  ${p.dim(g.arrow)} ${p.gold(evo.next.name)} ${p.snow(`${evo.xpToNext}xp`)}`
    : ` ${strip}  ${p.snow(evo.current.name)}`;
  return short;
}

/** The pet's rows: art with reactions, cracks, evolution and particles. */
function paddockRows(state, snap, evo, c, opts) {
  const { p } = c;
  const tick = opts.tick || 0;
  const behavior = opts.behavior || {};
  const ascii = c.ascii;
  const mood = snap.mood;

  const rocking = snap.stage.key === 'egg' && species.eggShakes(evo.stageProgress);
  const frame = Math.floor(tick / (rocking ? 2 : 4));
  const blinking = species.isBlinking(tick) && !state.sleeping && !behavior.face;
  let art = species.pose(snap.stage.key, mood, frame, blinking, {
    face: behavior.face || null,
    eggProgress: snap.stage.key === 'egg' ? evo.stageProgress : undefined,
  });

  let artColor = ART_COLOR[mood] || 'aqua';
  const ev = behavior.evolution;
  if (ev) {
    const from = species.pose(ev.from, 'ecstatic', frame, false);
    const to = species.pose(ev.to, 'ecstatic', frame, false);
    if (ev.t < 0.3) art = from;
    else if (ev.t < 0.6) art = species.silhouette(from, tick, ascii);
    else art = species.reveal(from, to, (ev.t - 0.6) / 0.4, tick, ascii);
    artColor = 'gold';
  }

  const bob = (Math.floor(tick / 6) % 2 === 0 ? '' : ' ') + ' '.repeat(behavior.bounce || 0);
  const deco = ev ? '' : species.accent(mood, tick);
  const artWidth = art[0].length + bob.length;
  const gutter = ' '.repeat(Math.max(0, Math.floor((c.inner - artWidth) / 2)));
  const burst = opts.particles || new Map();

  const tight = Boolean(opts.tight);
  const paddock = tight ? art : [''].concat(art, ['']);
  const decoRow = tight ? 1 : 2;

  paddock.forEach((line, row) => {
    const rowParticles = new Map();
    for (const [key, particle] of burst) {
      const [r, col] = key.split(',').map(Number);
      if (r === row) rowParticles.set(col, particle);
    }
    if (!line) {
      c.row(c.overlay(' '.repeat(c.inner), rowParticles, 'gray'));
      return;
    }
    const body = row === decoRow && deco ? `${gutter}${bob}${line}  ${deco}` : `${gutter}${bob}${line}`;
    const plain = a.pad(c.clip(body, c.inner), c.inner);
    c.row(c.overlay(plain, rowParticles, artColor));
  });

  const quip = ev
    ? p.bold(p.gold(ascii ? '* evolving *' : '\u2726 evolving \u2726'))
    : p.italic(p.dim(`" ${snap.quip} "`));
  c.centered(quip);
  if (!tight) c.row();
}

function vitalsRows(state, snap, evo, c, opts) {
  const { p } = c;
  const now = opts.now || Date.now();
  const cells = c.w >= 66 ? 14 : 9;
  c.sep('vitals');
  c.row(` ${c.gauge('satiety', state.satiety, 100, cells, `${Math.round(state.satiety)}%`)}`);
  c.row(` ${c.gauge('energy', state.energy, 100, cells, `${Math.round(state.energy)}%`)}`);
  c.row(` ${c.gauge('mood', state.mood, 100, cells, `${Math.round(state.mood)}%`)}`);
  c.row(` ${c.gauge('health', state.health, 100, cells, `${Math.round(state.health)}%`)}`);
  c.row(` ${c.gauge('xp', snap.xpRatio * 100, 100, cells, `${snap.xpInto}/${snap.xpNeed}`)}`);

  const days = vitals.activity(state, Math.min(TUNING.sparkDays, cells * 2), now);
  const spark = sparkline(days.map((d) => d.xp), c.ascii);
  const fedToday = days[days.length - 1].xp;
  c.row(` ${p.dim(a.pad(`${days.length}d`, 8))}${p.aqua(spark)} ${p.dim('today')} ${p.gold(`${fedToday}xp`)}`);
  c.row(roadRow(evo, c));
}

function summaryRow(state, c, opts) {
  const { p } = c;
  const now = opts.now || Date.now();
  const t = state.totals;
  c.row(` ${p.dim('treats')} ${p.gold(String(state.treats))}   ${p.dim('streak')} ${p.sky(`${state.streak.days}d`)}   `
    + `${p.dim('age')} ${p.snow(humanAge(now - state.hatchedAt))}   `
    + `${p.dim('fed')} ${p.lime(String(t.commit))}c ${p.aqua(String(t.push))}p ${p.pink(String(t.merge))}m`);
}

function badgesRow(state, c) {
  const { p } = c;
  const earned = (state.achievements || []).map((id) => achievements.get(id)).filter(Boolean);
  const icons = earned.slice(-8).map((b) => achievements.glyph(b, c.ascii)).join(' ');
  c.row(` ${p.dim('badges')} ${p.gold(icons || '-')}   ${p.dim(`${earned.length}/${achievements.all().length}`)}`);
}

function logRows(state, c, count) {
  const { p } = c;
  const recent = state.log.slice(-count).reverse();
  if (!recent.length) {
    c.row(p.dim(`  nothing yet ${c.ascii ? '-' : '\u2014'} make a commit and watch it eat`));
    return;
  }
  for (const e of recent) {
    const tag = a.pad((e.type === 'merge' ? 'MERGED' : e.type).toUpperCase(), 7);
    const colour = TYPE_COLOR[e.type] || 'snow';
    const head = ` ${p.dim(clock(e.ts))} ${p[colour](tag)} ${a.pad(c.clip(e.ref, 12), 12)} `;
    const xp = e.xp ? p.gold(`+${e.xp}`) : '   ';
    const room = c.inner - a.width(head) - a.width(xp) - 1;
    c.row(`${head}${a.pad(c.clip(e.detail, Math.max(0, room)), Math.max(0, room))} ${xp}`);
  }
}

function keysRow(c) {
  const { p } = c;
  const pairs = [['f', 'eed'], ['p', 'lay'], ['s', 'leep'], ['r', 'escan'], ['t', 'rack'], ['i', 'nfo'], ['c', 'olor'], ['?', ''], ['q', 'uit']];
  const full = pairs.map(([k, rest]) => `[${k}]${rest}`).join(' ');
  const verbose = a.width(full) + 1 <= c.inner;
  const keys = pairs
    .map(([k, rest]) => `${p.gold(`[${k}]`)}${verbose ? p.dim(rest) : ''}`)
    .join(verbose ? ' ' : '');
  c.row(` ${keys}`);
}

/** The single-column panel. */
function frame(state, opts = {}) {
  const now = opts.now || Date.now();
  const p = opts.palette || a.palette(false);
  const width = Math.max(46, Math.min(opts.width || 74, 100));
  const ascii = Boolean(opts.ascii);
  const snap = vitals.snapshot(state, now);
  const evo = vitals.evolution(state, now);

  const c = new Canvas({ width, p, ascii, frame: frameFor(snap.mood, opts.frame) });
  c.top(`${state.name}`, `lv ${snap.level} ${ascii ? '-' : '\u00b7'} ${snap.stage.name}`);

  paddockRows(state, snap, evo, c, { ...opts, now });
  vitalsRows(state, snap, evo, c, { ...opts, now });
  summaryRow(state, c, { ...opts, now });
  // Badges live on the stats screen too, so they are the row to give up when
  // the terminal is short.
  if (!opts.tight) badgesRow(state, c);

  const count = opts.logRows === undefined ? 5 : opts.logRows;
  if (count > 0) {
    c.sep('recently eaten');
    logRows(state, c, count);
  }
  if (opts.banner) { c.sep(); c.centered(opts.banner); }
  if (opts.status) { c.sep(); c.row(` ${opts.status}`); }
  if (opts.keys) { c.sep(); keysRow(c); }
  c.bottom();
  return c.lines;
}

/**
 * Two columns for wide terminals: the pet and its vitals on the left, the
 * feeding log, activity and badges given room on the right.
 */
function wideFrame(state, opts = {}) {
  const now = opts.now || Date.now();
  const p = opts.palette || a.palette(false);
  const total = Math.max(WIDE_MIN, Math.min(opts.width || WIDE_MIN, 160));
  const ascii = Boolean(opts.ascii);
  const snap = vitals.snapshot(state, now);
  const evo = vitals.evolution(state, now);
  const tint = frameFor(snap.mood, opts.frame);

  const leftWidth = Math.min(74, Math.floor(total * 0.55));
  const rightWidth = total - leftWidth - 1;

  const L = new Canvas({ width: leftWidth, p, ascii, frame: tint });
  L.top(`${state.name}`, `lv ${snap.level} ${ascii ? '-' : '\u00b7'} ${snap.stage.name}`);
  paddockRows(state, snap, evo, L, { ...opts, now, tight: false });
  vitalsRows(state, snap, evo, L, { ...opts, now });
  summaryRow(state, L, { ...opts, now });
  if (opts.status) { L.sep(); L.row(` ${opts.status}`); }
  if (opts.keys) { L.sep(); keysRow(L); }

  const R = new Canvas({ width: rightWidth, p, ascii, frame: tint });
  R.top('recently eaten', `${state.log.length} meals`);
  logRows(state, R, Math.max(6, (opts.logRows || 5) + 4));

  R.sep('last 30 days');
  const days = vitals.activity(state, 30, now);
  R.row(` ${p.aqua(sparkline(days.map((d) => d.xp), ascii))}`);
  const active = days.filter((d) => d.xp > 0).length;
  R.row(` ${p.dim(`${active} active days, ${days.reduce((n, d) => n + d.xp, 0)} xp, ${evo.xpPerDay} xp/day pace`)}`);

  R.sep(`badges ${(state.achievements || []).length}/${achievements.all().length}`);
  const earned = new Set(state.achievements || []);
  for (const badge of achievements.all().slice(0, Math.max(4, R.lines.length < 20 ? 13 : 6))) {
    const has = earned.has(badge.id);
    const glyph = achievements.glyph(badge, ascii);
    R.row(has
      ? ` ${p.gold(glyph)} ${p.snow(a.pad(badge.name, 16))} ${p.dim(R.clip(badge.how, R.inner - 22))}`
      : ` ${p.gray('-')} ${p.gray(a.pad(badge.name, 16))} ${p.gray(R.clip(badge.how, R.inner - 22))}`);
  }
  if (opts.banner) { R.sep(); R.centered(opts.banner); }

  const height = Math.max(L.lines.length, R.lines.length) + 1;
  L.padTo(height - 1).bottom();
  R.padTo(height - 1).bottom();
  return L.lines.map((line, i) => `${line} ${R.lines[i]}`);
}

module.exports = {
  frame, wideFrame, Canvas, sparkline, roadRow, clock, humanAge, ratioColor,
  TYPE_COLOR, WIDE_MIN, FRAME_COLORS, FRAME_CHOICES, frameFor,
};
