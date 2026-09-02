'use strict';

const fs = require('fs');
const path = require('path');
const { paths, TUNING } = require('./config');
const { describeFsError } = require('./errors');

const VERSION = 1;

function blank(now = Date.now()) {
  return {
    version: VERSION,
    name: 'Repotchi',
    hatchedAt: now,
    updatedAt: now,
    satiety: 68,
    energy: 80,
    mood: 62,
    health: 100,
    xp: 0,
    treats: 2,
    sleeping: false,
    lastFeastAt: 0,
    lastEventAt: 0,
    streak: { days: 0, lastDay: null },
    repos: {},
    ledger: [],
    log: [],
    history: {},
    achievements: [],
    prefs: {},
    wasSick: false,
    totals: { commit: 0, push: 0, merge: 0, tag: 0, streak: 0 },
  };
}

function load() {
  const file = paths().state;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return blank();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt file should not kill the pet; keep the damaged copy for forensics.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return blank();
  }
  return migrate(parsed);
}

function migrate(s) {
  const base = blank(s.hatchedAt || Date.now());
  const merged = { ...base, ...s };
  merged.streak = { ...base.streak, ...(s.streak || {}) };
  merged.totals = { ...base.totals, ...(s.totals || {}) };
  merged.repos = s.repos && typeof s.repos === 'object' ? s.repos : {};
  merged.ledger = Array.isArray(s.ledger) ? s.ledger : [];
  merged.log = Array.isArray(s.log) ? s.log : [];
  merged.achievements = Array.isArray(s.achievements) ? s.achievements : [];
  merged.history = s.history && typeof s.history === 'object' ? s.history : {};
  merged.prefs = s.prefs && typeof s.prefs === 'object' ? s.prefs : {};
  merged.version = VERSION;
  backfill(merged);
  return merged;
}

/**
 * Pets created before activity history and badges existed should not appear to
 * have done nothing. Both are reconstructed from the feeding log and totals.
 * Required lazily so this module keeps no load-order dependency on vitals.
 */
function backfill(s) {
  const vitals = require('./vitals');
  const achievements = require('./achievements');

  if (!Object.keys(s.history).length && s.log.length) {
    for (const entry of s.log) {
      if (entry && entry.xp > 0 && entry.ts) vitals.recordHistory(s, entry.ts, entry.xp);
    }
  }
  if (!s.achievements.length) {
    achievements.check(s, null, vitals.levelInfo(s.xp).level);
  }
  return s;
}

function save(state) {
  const p = paths();
  if (state.ledger.length > TUNING.ledgerLimit) {
    state.ledger = state.ledger.slice(-TUNING.ledgerLimit);
  }
  if (state.log.length > TUNING.logLimit) {
    state.log = state.log.slice(-TUNING.logLimit);
  }

  const tmp = path.join(p.home, `.state.${process.pid}.tmp`);
  try {
    fs.mkdirSync(p.home, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p.state);
  } catch (err) {
    // A pet that cannot be saved is a bug report, not a stack trace.
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw describeFsError(err, p.state);
  }
  return state;
}

/**
 * Read-modify-write against the file, returning the merged state and whatever
 * the mutator returned. The TUI is not the only writer: git hooks run
 * `pet scan` and other shells run `pet feed`, so keeping a long-lived copy in
 * memory and writing it back wholesale silently reverted their work.
 */
function update(mutate) {
  const fresh = load();
  const result = mutate(fresh);
  save(fresh);
  return { state: fresh, result };
}

function exists() {
  try {
    fs.accessSync(paths().state);
    return true;
  } catch {
    return false;
  }
}

function reset() {
  const p = paths();
  try { fs.unlinkSync(p.state); } catch { /* already gone */ }
  return save(blank());
}

function trackRepo(state, dir) {
  const key = path.resolve(dir);
  if (!state.repos[key]) {
    state.repos[key] = { seededAt: 0, lastScanMs: 0, remoteRefs: {}, tags: [] };
  }
  return key;
}

function untrackRepo(state, dir) {
  const key = path.resolve(dir);
  const had = Boolean(state.repos[key]);
  delete state.repos[key];
  return had;
}

module.exports = { blank, load, save, update, reset, exists, trackRepo, untrackRepo, VERSION };
