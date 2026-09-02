'use strict';

const a = require('./ansi');
const vitals = require('./vitals');
const achievements = require('./achievements');
const species = require('./species');
const { Canvas, sparkline, humanAge } = require('./render');
const { STAGES, NUTRITION } = require('./config');

/** Below this the boxed layout cannot be drawn without wrapping. */
const MIN_PANEL = 46;

function canvasFor(opts) {
  const width = Math.max(MIN_PANEL, Math.min(opts.width || 74, 100));
  return new Canvas({ width, p: opts.palette || a.palette(false), ascii: Boolean(opts.ascii) });
}

/**
 * Shown when nothing is tracked yet. A brand new user should not have to read
 * the README to discover the two commands that make anything happen.
 */
function onboarding(opts = {}) {
  const c = canvasFor(opts);
  const { p } = c;
  const ascii = c.ascii;
  const arrow = ascii ? '->' : '\u2192';

  c.top('Welcome to repotchi', 'first run');
  c.row();
  for (const line of species.pose('egg', 'neutral', 0, false)) {
    c.centered(p.aqua(line));
  }
  c.row();
  c.centered(p.italic(p.dim('" something is moving in there... "')));
  c.row();

  c.sep('hatch it in two steps');
  c.row();
  c.row(`  ${p.gold('1.')} ${p.snow('cd into a git repository you work in')}`);
  c.row(`     ${p.dim('then press')} ${p.gold('[t]')} ${p.dim('here, or run')} ${p.snow('pet track')}`);
  c.row();
  c.row(`  ${p.gold('2.')} ${p.snow('commit something')}`);
  c.row(`     ${p.dim('your pet eats it within 8 seconds')}`);
  c.row();

  c.sep('what it eats');
  for (const [kind, food] of Object.entries(NUTRITION)) {
    if (kind === 'streak') continue;
    const label = kind === 'merge' ? 'merged MR' : kind;
    c.row(`  ${p.lime(a.pad(label, 12))}${p.dim(`+${food.xp} xp`)}`);
  }
  c.row();
  c.row(`  ${p.dim('Ignore your repo and it gets hungry, then sick.')}`);
  c.row(`  ${p.dim('Ship something and it evolves.')}`);
  c.row();

  if (opts.status) {
    c.sep();
    c.row(` ${opts.status}`);
  }

  c.sep();
  c.row(` ${p.gold('[t]')}${p.dim('rack here')}  ${p.gold('[?]')}${p.dim('help')}  ${p.gold('[q]')}${p.dim('uit')}   ${p.dim(`${arrow} setup trouble? run`)} ${p.snow('pet doctor')}`);
  c.bottom();
  return c.lines;
}

/** The full detail view: everything the compact panel has no room for. */
function stats(state, opts = {}) {
  const c = canvasFor(opts);
  const { p } = c;
  const ascii = c.ascii;
  const now = opts.now || Date.now();
  const snap = vitals.snapshot(state, now);

  c.top(`${state.name}`, 'stats');
  c.row();
  c.row(`  ${p.dim(a.pad('stage', 14))}${p.snow(snap.stage.name)} ${p.dim(`(level ${snap.level})`)}`);
  c.row(`  ${p.dim(a.pad('hatched', 14))}${p.snow(new Date(state.hatchedAt).toLocaleString())} ${p.dim(`(${humanAge(now - state.hatchedAt)} ago)`)}`);
  c.row(`  ${p.dim(a.pad('last meal', 14))}${state.lastEventAt ? p.snow(`${humanAge(now - state.lastEventAt)} ago`) : p.gold('never')}`);
  c.row(`  ${p.dim(a.pad('streak', 14))}${p.sky(`${state.streak.days} day${state.streak.days === 1 ? '' : 's'}`)}`);
  c.row(`  ${p.dim(a.pad('total xp', 14))}${p.gold(String(state.xp))}`);
  c.row();

  c.sep('lifetime meals');
  const t = state.totals;
  const meals = [
    ['commits', t.commit, 'lime'],
    ['pushes', t.push, 'aqua'],
    ['merged MRs', t.merge, 'pink'],
    ['tags', t.tag, 'gold'],
    ['streak bonuses', t.streak, 'sky'],
  ];
  const most = Math.max(1, ...meals.map(([, n]) => n));
  for (const [label, n, colour] of meals) {
    const barWidth = Math.max(0, c.inner - 26);
    const filled = Math.round((n / most) * barWidth);
    c.row(`  ${p.dim(a.pad(label, 16))}${p[colour]((ascii ? '#' : '\u2588').repeat(filled))}${p.gray((ascii ? '.' : '\u2591').repeat(barWidth - filled))} ${a.padStart(String(n), 5)}`);
  }
  c.row();

  c.sep('last 30 days');
  const days = vitals.activity(state, 30, now);
  c.row(`  ${p.aqua(sparkline(days.map((d) => d.xp), ascii))}`);
  const active = days.filter((d) => d.xp > 0).length;
  const total = days.reduce((n, d) => n + d.xp, 0);
  c.row(`  ${p.dim(`${active} active days, ${total} xp, best day ${Math.max(0, ...days.map((d) => d.xp))} xp`)}`);
  c.row();

  c.sep('evolution');
  const evo = vitals.evolution(state, now);
  const marks = ascii ? { done: '#', here: '@', todo: '.' } : { done: '\u2726', here: '\u2739', todo: '\u2727' };
  for (const stage of evo.road) {
    const mark = stage.here ? p.bold(p.gold(marks.here)) : stage.reached ? p.lime(marks.done) : p.gray(marks.todo);
    const name = stage.here ? p.bold(p.snow(a.pad(stage.name, 16))) : stage.reached ? p.snow(a.pad(stage.name, 16)) : p.gray(a.pad(stage.name, 16));
    const at = p.dim(`lv ${String(stage.min).padStart(2)}  ${String(stage.xpAt).padStart(5)} xp`);
    let tail = '';
    if (stage.here) tail = p.gold(`  ${ascii ? '<-' : '\u2190'} you, ${snap.xpInto}/${snap.xpNeed} into lv ${snap.level}`);
    else if (evo.next && stage.key === evo.next.key) {
      const eta = evo.etaDays ? ` ${ascii ? '~' : '\u2248'}${evo.etaDays} days at ${evo.xpPerDay} xp/day` : ' (no recent pace to estimate)';
      tail = p.gold(`  in ${evo.xpToNext} xp${eta}`);
    }
    c.row(`  ${mark} ${name} ${at}${tail}`);
  }
  if (!evo.next) c.row(`  ${p.dim('final form reached. there is nothing left to become.')}`);
  c.row();

  c.sep(`badges ${(state.achievements || []).length}/${achievements.all().length}`);
  for (const badge of achievements.all()) {
    const has = (state.achievements || []).includes(badge.id);
    const glyph = achievements.glyph(badge, ascii);
    const name = a.pad(badge.name, 17);
    c.row(has
      ? `  ${p.gold(glyph)} ${p.snow(name)} ${p.dim(badge.how)}`
      : `  ${p.gray('-')} ${p.gray(name)} ${p.gray(badge.how)}`);
  }
  c.row();

  c.sep('watching');
  const repos = Object.keys(state.repos);
  if (!repos.length) c.row(`  ${p.gold('nothing tracked yet')}`);
  for (const repo of repos) c.row(`  ${p.dim(c.clip(repo, c.inner - 4))}`);
  c.row();

  c.sep();
  c.row(` ${p.gold('[i]')}${p.dim(' or ')}${p.gold('[esc]')}${p.dim(' back to your pet')}   ${p.gold('[q]')}${p.dim('uit')}`);
  c.bottom();
  return c.lines;
}

/**
 * For terminals too narrow to hold the panel. Drawing a 46-column box into a
 * 40-column window wraps every line and turns the pet into confetti, so below
 * the threshold we drop the box entirely rather than render something broken.
 */
function compact(state, opts = {}) {
  const p = opts.palette || a.palette(false);
  const width = Math.max(12, opts.columns || 40);
  const now = opts.now || Date.now();
  const snap = vitals.snapshot(state, now);
  const face = species.FACES[snap.mood] || species.FACES.neutral;
  const ell = opts.ascii ? '.' : '\u2026';
  const line = (s) => a.clip(s, width, ell);

  const out = [
    line(`${p.aqua(`(${face.l}${face.m}${face.r})`)} ${p.bold(p.snow(state.name))}`),
    line(`${p.dim('lv')}${snap.level} ${p.dim(snap.stage.name)}`),
    '',
    line(`${p.dim('sat    ')}${p.snow(`${Math.round(state.satiety)}%`)}`),
    line(`${p.dim('energy ')}${p.snow(`${Math.round(state.energy)}%`)}`),
    line(`${p.dim('mood   ')}${p.snow(`${Math.round(state.mood)}%`)}`),
    line(`${p.dim('health ')}${p.snow(`${Math.round(state.health)}%`)}`),
    line(`${p.dim('streak ')}${p.sky(`${state.streak.days}d`)}`),
    '',
    line(p.gold(opts.reason === 'short' ? 'terminal too short' : 'terminal too narrow')),
    line(p.dim(opts.reason === 'short' ? 'needs 24 rows' : `widen to ${MIN_PANEL} columns`)),
    line(p.dim('for the full view')),
  ];
  if (opts.keys) out.push('', line(`${p.gold('[q]')}${p.dim('uit')}`));
  return out;
}

function help(opts = {}) {
  const c = canvasFor(opts);
  const { p } = c;
  const ascii = c.ascii;

  c.top('repotchi', 'help');
  c.row();
  c.sep('keys');
  const keys = [
    ['f', 'feed a treat you have earned from git activity'],
    ['p', 'play: mood up, energy down'],
    ['s', 'sleep: energy recovers, hunger slows'],
    ['r', 'rescan your repos right now'],
    ['t', 'track the repo in the current directory'],
    ['n', 'rename your pet'],
    ['i', 'stats, badges and evolution'],
    ['c', 'cycle the frame colour (saved; or pet config frame <colour>)'],
    ['l', 'cycle how many log lines are shown'],
    ['?', 'this help'],
    ['q', 'quit (your pet is saved)'],
  ];
  for (const [k, what] of keys) c.row(`  ${p.gold(a.pad(`[${k}]`, 6))}${p.snow(what)}`);
  c.row();

  c.sep('what feeds it');
  c.row(`  ${p.lime(a.pad('commit', 12))}${p.dim('+6 xp, more for a bigger diff')}`);
  c.row(`  ${p.aqua(a.pad('push', 12))}${p.dim('+14 xp, detected from the reflog, not from fetches')}`);
  c.row(`  ${p.pink(a.pad('merged MR', 12))}${p.dim('+40 xp, the feast')}`);
  c.row(`  ${p.gold(a.pad('tag', 12))}${p.dim('+26 xp')}`);
  c.row();
  c.row(`  ${p.dim('Opening an MR or editing its description changes nothing:')}`);
  c.row(`  ${p.dim('only what reaches your local git counts. A merged MR feeds')}`);
  c.row(`  ${p.dim('the pet once you fetch or pull the merge commit.')}`);
  c.row();

  c.sep('if it never eats');
  c.row(`  ${p.snow('pet doctor')} ${p.dim(`${ascii ? '-' : '\u2014'} the usual cause is that your git user.email`)}`);
  c.row(`  ${p.dim('does not match the author of the commits arriving.')}`);
  c.row();

  c.sep();
  c.row(` ${p.dim('press any key to go back')}`);
  c.bottom();
  return c.lines;
}

module.exports = { onboarding, stats, help, compact, MIN_PANEL };
