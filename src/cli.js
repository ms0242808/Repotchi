'use strict';

const fs = require('fs');
const path = require('path');
const a = require('./ansi');
const store = require('./state');
const vitals = require('./vitals');
const render = require('./render');
const feeder = require('./feeder');
const git = require('./git');
const species = require('./species');
const env = require('./env');
const doctor = require('./doctor');
const screens = require('./screens');
const { Tui } = require('./tui');
const { paths } = require('./config');
const { PetError } = require('./errors');

const VERSION = require('../package.json').version;

const COMMANDS = [
  'render', 'scan', 'status', 'track', 'untrack', 'repos',
  'feed', 'demo', 'hook', 'doctor', 'config', 'reset', 'help',
];

/** Settings a user can save with `pet config`, with their allowed values. */
const SETTINGS = {
  frame: {
    values: render.FRAME_CHOICES,
    describe: 'colour of the panel frame; "mood" follows how the pet feels',
  },
};

const FLAGS_WITH_VALUES = new Set(['--width', '--stage', '--mood', '--interval', '--frame']);
const BOOL_FLAGS = new Set([
  '--no-color', '--color', '--ascii', '--unicode', '--quiet', '-q',
  '--all', '--yes', '-y', '--version', '-v', '--help', '-h',
]);

function positiveNumber(name, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PetError(`${name} needs a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parse(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-color') flags.noColor = true;
    else if (arg === '--color') flags.color = true;
    else if (arg === '--ascii') flags.ascii = true;
    else if (arg === '--unicode') flags.unicode = true;
    else if (arg === '--quiet' || arg === '-q') flags.quiet = true;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--version' || arg === '-v') flags.version = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--width') flags.width = positiveNumber('--width', argv[++i]);
    else if (arg === '--interval') flags.interval = positiveNumber('--interval', argv[++i]) * 1000;
    else if (arg === '--stage') flags.stage = argv[++i];
    else if (arg === '--mood') flags.mood = argv[++i];
    else if (arg === '--frame') {
      const v = argv[++i];
      if (!render.FRAME_CHOICES.includes(v)) {
        throw new PetError(`unknown frame colour ${JSON.stringify(v)}`, `try one of: ${render.FRAME_CHOICES.join(', ')}`);
      }
      flags.frame = v;
    } else if (arg.startsWith('-')) {
      const known = [...FLAGS_WITH_VALUES, ...BOOL_FLAGS].sort().join(' ');
      throw new PetError(`unknown option ${arg}`, `known options: ${known}`);
    } else flags._.push(arg);
  }
  return flags;
}

/** Unicode is used only where the terminal can actually render it. */
function wantsAscii(flags) {
  if (flags.ascii) return true;
  if (flags.unicode) return false;
  return !env.unicodeSupported();
}

function makePalette(flags) {
  return a.palette(a.supportsColor(process.stdout, flags));
}

/** Flag beats saved preference beats the default. */
function framePref(state, flags) {
  return flags.frame || (state.prefs && state.prefs.frame) || 'mood';
}

function printFrame(state, flags, extra = {}) {
  const p = makePalette(flags);
  const width = flags.width || Math.min((process.stdout.columns || 76) - 2, 74);
  const lines = render.frame(state, {
    palette: p, width, ascii: wantsAscii(flags), tick: 0, frame: framePref(state, flags), ...extra,
  });
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdRender(flags) {
  const state = store.load();
  vitals.decay(state, Date.now());
  store.save(state);

  const columns = process.stdout.columns || 0;
  if (!flags.width && columns && columns < screens.MIN_PANEL) {
    const p = makePalette(flags);
    const lines = screens.compact(state, { columns, palette: p, ascii: wantsAscii(flags) });
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  printFrame(state, flags);
}

function describe(event, p) {
  const colour = { commit: 'lime', push: 'aqua', merge: 'pink', tag: 'gold', streak: 'sky' }[event.type] || 'snow';
  const label = event.type === 'merge' ? 'MERGED' : event.type.toUpperCase();
  return `${p[colour](label.padEnd(7))} ${p.dim(event.ref || '')} ${event.detail || ''}`;
}

function cmdScan(flags) {
  const p = makePalette(flags);
  git.requireGit();
  const state = store.load();
  const summary = feeder.scanAll(state, Date.now());
  store.save(state);
  if (flags.quiet) return;

  for (const e of summary.errors) {
    process.stdout.write(`${p.hotRed('!')} ${e.repo}: ${e.error}\n`);
  }
  for (const r of summary.seeded) {
    process.stdout.write(`${p.dim('baseline recorded for')} ${r}\n`);
  }
  if (!summary.fed.length) {
    if (!Object.keys(state.repos).length) {
      process.stdout.write(`${p.gold('no repositories tracked.')} ${p.dim('run')} pet track ${p.dim('inside one.')}\n`);
      return;
    }
    const snap = vitals.snapshot(state);
    process.stdout.write(`${p.dim('nothing new to eat.')} ${state.name} is ${p.snow(snap.mood)} (satiety ${Math.round(state.satiety)}%).\n`);
    return;
  }
  for (const f of summary.fed) {
    process.stdout.write(`${describe(f.event, p)} ${p.gold(`+${f.gained.xp}xp`)}\n`);
  }
  for (const l of summary.levelled) {
    process.stdout.write(`${p.bold(p.gold(`LEVEL ${l.to}`))} ${p.snow(l.stage.name)}\n`);
  }
  for (const u of summary.unlocked || []) {
    process.stdout.write(`${p.bold(p.pink('UNLOCKED'))} ${p.snow(u.icon)} ${u.name} ${p.dim(`\u2014 ${u.how}`)}\n`);
  }
}

function cmdStatus(flags) {
  const p = makePalette(flags);
  const state = store.load();
  vitals.decay(state, Date.now());
  const snap = vitals.snapshot(state);
  const face = species.FACES[snap.mood] || species.FACES.neutral;
  process.stdout.write(
    `${p.aqua(`(${face.l}${face.m}${face.r})`)} ${p.snow(state.name)} `
    + `${p.dim('lv')}${snap.level} ${p.dim('sat')}${Math.round(state.satiety)}% `
    + `${p.dim('mood')}${Math.round(state.mood)}% ${p.dim('streak')}${state.streak.days}d\n`,
  );
}

function resolveRepo(flags, index = 1) {
  const target = flags._[index] ? path.resolve(flags._[index]) : process.cwd();
  git.requireGit();
  const root = git.repoRoot(target);
  if (!root) {
    throw new PetError(`${target} is not a git repository`, 'cd into a repository, or pass its path: pet track /path/to/repo');
  }
  return root;
}

function cmdTrack(flags) {
  const p = makePalette(flags);
  const root = resolveRepo(flags);
  const state = store.load();
  const key = store.trackRepo(state, root);
  const summary = feeder.scanAll(state, Date.now());
  store.save(state);
  process.stdout.write(`${p.lime('tracking')} ${key}\n`);
  if (summary.seeded.includes(key)) {
    process.stdout.write(`${p.dim('baseline recorded \u2014 only new activity counts from here.')}\n`);
  }
  process.stdout.write(`${p.dim('next:')} pet ${p.dim('for the live view, or')} pet hook install ${p.dim('to feed on every commit.')}\n`);
}

function cmdUntrack(flags) {
  const p = makePalette(flags);
  const target = flags._[1] ? path.resolve(flags._[1]) : process.cwd();
  const state = store.load();
  const root = (git.available() && git.repoRoot(target)) || target;
  const had = store.untrackRepo(state, root);
  store.save(state);
  process.stdout.write(had ? `${p.gold('untracked')} ${root}\n` : `${p.dim('was not tracked:')} ${root}\n`);
}

function cmdRepos(flags) {
  const p = makePalette(flags);
  const state = store.load();
  const entries = Object.entries(state.repos);
  if (!entries.length) {
    process.stdout.write(`${p.dim('no repos tracked. run')} pet track ${p.dim('inside one.')}\n`);
    return;
  }
  for (const [repo, cursor] of entries) {
    const ok = git.isRepo(repo);
    const when = cursor.lastScanMs ? render.humanAge(Date.now() - cursor.lastScanMs) : 'never';
    const dot = ok ? p.lime('\u25cf') : p.hotRed('\u25cf');
    const note = ok ? p.dim(`scanned ${when} ago`) : p.hotRed('missing \u2014 pet untrack it');
    process.stdout.write(`${dot} ${a.pad(repo, 48)} ${note}\n`);
  }
}

function cmdFeed(flags) {
  const p = makePalette(flags);
  const { state } = store.update((s) => {
    vitals.decay(s, Date.now());
    if (s.treats <= 0) return;
    s.treats -= 1;
    s.satiety = vitals.clamp(s.satiety + 16);
    s.mood = vitals.clamp(s.mood + 4);
    s.sleeping = false;
  });
  if (state.treats <= 0 && state.satiety < 16) {
    process.stdout.write(`${p.gold('no treats.')} ${p.dim('commit something to earn one.')}\n`);
  } else {
    process.stdout.write(`${p.lime('nom.')} ${p.dim(`satiety ${Math.round(state.satiety)}%, ${state.treats} treats left`)}\n`);
  }
}

function cmdDemo(flags) {
  const p = makePalette(flags);
  const allStages = species.stageKeys();
  const allMoods = Object.keys(species.FACES);
  if (flags.stage && !allStages.includes(flags.stage)) {
    throw new PetError(`unknown stage ${JSON.stringify(flags.stage)}`, `try one of: ${allStages.join(', ')}`);
  }
  if (flags.mood && !allMoods.includes(flags.mood)) {
    throw new PetError(`unknown mood ${JSON.stringify(flags.mood)}`, `try one of: ${allMoods.join(', ')}`);
  }
  const stages = flags.stage ? [flags.stage] : allStages;
  const moods = flags.mood ? [flags.mood] : ['happy', 'hungry', 'sleeping', 'ecstatic', 'sick'];
  for (const stage of stages) {
    for (const mood of (flags.all ? moods : [moods[0]])) {
      process.stdout.write(`${p.bold(p.snow(`${stage} / ${mood}`))}\n`);
      for (const line of species.pose(stage, mood, 0, false)) process.stdout.write(`${p.aqua(line)}\n`);
      process.stdout.write('\n');
    }
  }
}

const HOOKS = ['post-commit', 'post-merge', 'post-checkout'];

function cmdHook(flags) {
  const p = makePalette(flags);
  const action = flags._[1] || 'install';
  if (action !== 'install' && action !== 'uninstall') {
    throw new PetError(`unknown hook action ${JSON.stringify(action)}`, 'use `pet hook install` or `pet hook uninstall`');
  }
  const root = resolveRepo(flags, 2);
  const dir = path.join(root, '.git', 'hooks');
  const bin = path.resolve(__dirname, '..', 'bin', 'pet');

  for (const hook of HOOKS) {
    const file = path.join(dir, hook);
    if (action === 'uninstall') {
      try {
        if (fs.readFileSync(file, 'utf8').includes('repotchi')) {
          fs.unlinkSync(file);
          process.stdout.write(`${p.gold('removed')} ${file}\n`);
        }
      } catch { /* nothing to remove */ }
      continue;
    }
    try {
      if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('repotchi')) {
        process.stdout.write(`${p.gold('skipped')} ${file} ${p.dim('(you already have a hook there)')}\n`);
        continue;
      }
      // Quoted paths and `sh` keep this working on Windows via Git Bash too.
      const body = `#!/bin/sh\n# repotchi: feed the terminal pet\n"${process.execPath}" "${bin}" scan --quiet >/dev/null 2>&1 &\nexit 0\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, { mode: 0o755 });
      process.stdout.write(`${p.lime('installed')} ${file}\n`);
    } catch (err) {
      throw new PetError(`could not write ${file}: ${err.message}`, 'check the repository permissions');
    }
  }
}

const LEVEL_MARK = { ok: ['lime', '\u2713', 'ok  '], warn: ['gold', '!', 'warn'], fail: ['hotRed', '\u2717', 'FAIL'] };

function cmdDoctor(flags) {
  const p = makePalette(flags);
  const ascii = wantsAscii(flags);
  const { checks, worst } = doctor.diagnose();

  process.stdout.write(`${p.bold('repotchi doctor')} ${p.dim(`v${VERSION}`)}\n\n`);
  for (const c of checks) {
    const [colour, glyph, word] = LEVEL_MARK[c.level];
    const mark = ascii ? word : glyph;
    process.stdout.write(`  ${p[colour](mark)} ${p.dim(a.pad(c.label, 10))} ${c.detail}\n`);
    if (c.fix) process.stdout.write(`      ${p.dim(ascii ? '->' : '\u2192')} ${p.gold(c.fix)}\n`);
  }

  const summary = {
    ok: p.lime('everything looks healthy.'),
    warn: p.gold('usable, but see the warnings above.'),
    fail: p.hotRed('something is broken \u2014 fix the failures above.'),
  }[worst];
  process.stdout.write(`\n  ${summary}\n`);
  if (worst === 'fail') process.exitCode = 1;
}

/**
 *   pet config                 list every setting and its current value
 *   pet config frame           show one
 *   pet config frame blue      set it
 *   pet config frame mood      back to the default
 */
function cmdConfig(flags) {
  const p = makePalette(flags);
  const [, key, value] = flags._;
  const state = store.load();
  const prefs = state.prefs || {};

  if (!key) {
    for (const [name, spec] of Object.entries(SETTINGS)) {
      const current = prefs[name] || spec.values[0];
      process.stdout.write(`  ${p.snow(a.pad(name, 8))} ${p.gold(a.pad(current, 10))} ${p.dim(spec.describe)}\n`);
      process.stdout.write(`  ${' '.repeat(8)} ${p.dim(`options: ${spec.values.join(', ')}`)}\n`);
    }
    return;
  }

  const spec = SETTINGS[key];
  if (!spec) {
    throw new PetError(`unknown setting ${JSON.stringify(key)}`, `settings: ${Object.keys(SETTINGS).join(', ')}`);
  }
  if (value === undefined) {
    process.stdout.write(`${prefs[key] || spec.values[0]}\n`);
    return;
  }
  if (!spec.values.includes(value)) {
    throw new PetError(`${key} cannot be ${JSON.stringify(value)}`, `try one of: ${spec.values.join(', ')}`);
  }
  store.update((s) => {
    s.prefs = { ...(s.prefs || {}), [key]: value };
  });
  process.stdout.write(`${p.lime(key)} ${p.dim('=')} ${p.gold(value)}\n`);
}

function cmdReset(flags) {
  const p = makePalette(flags);
  if (!flags.yes && store.exists()) {
    const state = store.load();
    const snap = vitals.snapshot(state);
    process.stdout.write(
      `${p.gold('this deletes')} ${p.snow(state.name)}${p.gold(',')} `
      + `${p.dim(`level ${snap.level} ${snap.stage.name}, ${state.totals.commit} commits eaten.`)}\n`
      + `${p.dim('re-run with')} --yes ${p.dim('to confirm.')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  store.reset();
  process.stdout.write(`${p.gold('a new egg appears.')} ${p.dim(paths().state)}\n`);
}

function cmdHelp(flags) {
  const p = makePalette(flags || {});
  process.stdout.write(`${p.bold('repotchi')} ${p.dim(`v${VERSION}`)} \u2014 a terminal pet fed by your git activity

${p.bold('getting started')}
  ${p.gold('cd ~/code/your-project')}
  ${p.gold('pet track')}              ${p.dim('watch this repo')}
  ${p.gold('pet hook install')}       ${p.dim('feed it automatically on every commit')}
  ${p.gold('pet')}                    ${p.dim('open the live view')}

${p.bold('commands')}
  pet                      open the live TUI
  pet render               print one frame and exit
  pet scan [--quiet]       look for new git activity and feed the pet
  pet status               one-line summary, for a shell prompt
  pet doctor               check your setup and explain anything wrong
  pet config [key] [value] show or change settings (e.g. pet config frame blue)
  pet track [path]         watch a repo (defaults to current directory)
  pet untrack [path]       stop watching a repo
  pet repos                list watched repos
  pet feed                 spend a treat
  pet demo [--all]         preview evolution stages and moods
  pet hook install|uninstall [path]
  pet reset --yes          start over from an egg

${p.bold('options')}
  --ascii / --unicode      force the character set (auto-detected)
  --color / --no-color     force colour on or off
  --frame COLOUR           panel frame for this run: ${render.FRAME_CHOICES.join(', ')}
  --width N                panel width for render
  --interval N             TUI git scan interval in seconds

${p.bold('what it eats')}
  ${p.lime('commit')}  small meal, scaled by diff size
  ${p.aqua('push')}    detected from remote-tracking reflogs
  ${p.pink('merge')}   merged MR/PR \u2014 the big feast
  ${p.gold('tag')}     a release-sized snack

  ${p.dim('Nothing server-side counts: opening an MR or editing its description')}
  ${p.dim('never touches local git. A merged MR feeds it once you fetch or pull.')}

${p.bold('troubleshooting')}
  ${p.dim('Pet never eats? Run')} pet doctor ${p.dim('\u2014 the usual cause is that your')}
  ${p.dim('git user.email differs from the author of the incoming commits.')}

${p.dim(`state lives in ${paths().state}`)}
`);
}

function cmdTui(flags) {
  const state = store.load();
  vitals.decay(state, Date.now());
  const ascii = wantsAscii(flags);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const p = makePalette(flags);
    printFrame(state, flags, { keys: true, status: p.dim('(static frame: no interactive terminal detected)') });
    process.stdout.write(`${p.dim('run this in a real terminal for the animated, interactive version.')}\n`);
    store.save(state);
    return;
  }
  new Tui(state, { ...flags, ascii, frame: framePref(state, flags) }).start();
}

function dispatch(flags) {
  switch (flags._[0]) {
    case undefined: return cmdTui(flags);
    case 'render': return cmdRender(flags);
    case 'scan': return cmdScan(flags);
    case 'status': return cmdStatus(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'track': return cmdTrack(flags);
    case 'untrack': return cmdUntrack(flags);
    case 'repos': return cmdRepos(flags);
    case 'feed': return cmdFeed(flags);
    case 'demo': return cmdDemo(flags);
    case 'hook': return cmdHook(flags);
    case 'config': return cmdConfig(flags);
    case 'reset': return cmdReset(flags);
    case 'help': return cmdHelp(flags);
    default:
      throw new PetError(`unknown command ${JSON.stringify(flags._[0])}`, `commands: ${COMMANDS.join(', ')}`);
  }
}

/** Anything that escapes dispatch is reported as advice or as a bug, never as a stack trace. */
function report(err) {
  const p = a.palette(a.supportsColor(process.stderr, {}));
  if (err instanceof PetError || (err && err.expected)) {
    process.stderr.write(`${p.hotRed('error:')} ${err.message}\n`);
    if (err.hint) process.stderr.write(`${p.dim('hint:')}  ${err.hint}\n`);
  } else {
    process.stderr.write(`${p.hotRed('repotchi hit an unexpected error.')} ${p.dim('This is a bug.')}\n`);
    process.stderr.write(`${(err && err.stack) || err}\n`);
    process.stderr.write(`${p.dim('please report it with the output of')} pet doctor\n`);
  }
  process.exitCode = 1;
}

function guardStreams() {
  // Piping into `head` closes stdout early; that is not a crash.
  const quiet = (stream) => stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  quiet(process.stdout);
  quiet(process.stderr);
}

function main(argv) {
  guardStreams();
  const node = env.nodeInfo();
  if (!node.ok) {
    process.stderr.write(`repotchi needs Node ${node.min} or newer; this is v${node.version}\n`);
    process.exitCode = 1;
    return undefined;
  }

  let flags;
  try {
    flags = parse(argv);
  } catch (err) {
    return report(err);
  }

  if (flags.version) return process.stdout.write(`${VERSION}\n`);
  if (flags.help) return cmdHelp(flags);

  try {
    return dispatch(flags);
  } catch (err) {
    return report(err);
  }
}

module.exports = { main, parse, COMMANDS };
