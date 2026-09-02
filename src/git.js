'use strict';

const { execFile, execFileSync } = require('child_process');
const path = require('path');
const { TUNING } = require('./config');
const env = require('./env');
const { PetError } = require('./errors');

const US = '\x1f';
const RS = '\x1e';

/**
 * GitLab squash/merge commits and GitHub merges both announce themselves, but
 * GitLab puts "See merge request" in the body rather than the subject line, so
 * this is matched against the whole message.
 */
const MR_MESSAGE = /(see merge request|merge pull request|merge branch .+ into )/i;
const MR_NUMBER = /[!#](\d+)/;

function git(dir, args, timeout = 10000) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    }).replace(/\s+$/, '');
  } catch {
    return null;
  }
}

const available = () => env.gitInfo().ok;

/** Raise before doing anything that silently no-ops without git installed. */
function requireGit() {
  const info = env.gitInfo();
  if (info.ok) return info;
  throw new PetError(
    `git is ${info.reason || 'unavailable'}`,
    'repotchi reads your local git history, so git must be on your PATH',
  );
}

function isRepo(dir) {
  if (!available()) return false;
  return git(dir, ['rev-parse', '--git-dir'], 4000) !== null;
}

function repoRoot(dir) {
  if (!available()) return null;
  return git(dir, ['rev-parse', '--show-toplevel'], 4000);
}

/** Distinct author emails seen recently, so `pet doctor` can spot a mismatch. */
function recentAuthors(dir, limit = 200) {
  const out = git(dir, ['log', '--all', `--max-count=${limit}`, '--pretty=format:%ae']);
  const counts = new Map();
  if (!out) return [];
  for (const raw of out.split('\n')) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    counts.set(email, (counts.get(email) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count);
}

function identity(dir) {
  return {
    email: (git(dir, ['config', '--get', 'user.email']) || '').toLowerCase(),
    name: git(dir, ['config', '--get', 'user.name']) || '',
  };
}

function shortName(dir) {
  return path.basename(dir);
}

function parseChurn(chunkLines) {
  let churn = 0;
  for (const line of chunkLines) {
    const ins = line.match(/(\d+) insertion/);
    const del = line.match(/(\d+) deletion/);
    if (ins) churn += Number(ins[1]);
    if (del) churn += Number(del[1]);
  }
  return churn;
}

/** Bigger diffs are bigger meals, but with sharply diminishing returns. */
function mealFactor(churn) {
  if (!churn) return 1;
  const f = 1 + Math.log10(1 + churn) / 3.2;
  return Math.min(2.2, Math.round(f * 100) / 100);
}

/**
 * Full commit messages keyed by sha. Fetched separately because a multi-line
 * body cannot share a record with --shortstat without the two becoming
 * ambiguous.
 */
function readMessages(dir, sinceIso) {
  const out = git(dir, [
    'log', '--all', `--since=${sinceIso}`, '--max-count=400',
    `--pretty=format:%H${US}%B${RS}`,
  ]);
  const map = new Map();
  if (!out) return map;
  for (const record of out.split(RS)) {
    const cut = record.indexOf(US);
    if (cut < 0) continue;
    map.set(record.slice(0, cut).trim(), record.slice(cut + 1));
  }
  return map;
}

function readCommits(dir, sinceIso, mine, messages) {
  const fmt = `${RS}%H${US}%ct${US}%ae${US}%an${US}%s`;
  const out = git(dir, [
    'log', '--all', '--no-merges', `--since=${sinceIso}`,
    '--max-count=400', `--pretty=format:${fmt}`, '--shortstat',
  ]);
  if (!out) return [];
  const events = [];
  for (const chunk of out.split(RS)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const [sha, ts, email, author, ...rest] = lines[0].split(US);
    if (!sha) continue;
    if (mine && email && email.toLowerCase() !== mine) continue;
    const subject = rest.join(US);
    const churn = parseChurn(lines.slice(1));
    const message = messages.get(sha) || subject;
    const merged = MR_MESSAGE.test(message);
    const num = merged ? message.match(MR_NUMBER) : null;
    events.push({
      id: `${merged ? 'merge' : 'commit'}:${sha}`,
      type: merged ? 'merge' : 'commit',
      at: Number(ts) * 1000,
      ref: num ? `!${num[1]}` : sha.slice(0, 7),
      detail: subject,
      author,
      churn,
      factor: merged ? 1 : mealFactor(churn),
    });
  }
  return events;
}

function readMerges(dir, sinceIso, mine, messages) {
  const fmt = `%H${US}%ct${US}%ae${US}%an${US}%s`;
  const out = git(dir, [
    'log', '--all', '--merges', `--since=${sinceIso}`,
    '--max-count=200', `--pretty=format:${fmt}`,
  ]);
  if (!out) return [];
  const events = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, ts, email, author, ...rest] = line.split(US);
    if (!sha) continue;
    const subject = rest.join(US);
    // Merges made by someone else still count only if we authored them locally.
    if (mine && email && email.toLowerCase() !== mine) continue;
    const num = (messages.get(sha) || subject).match(MR_NUMBER);
    events.push({
      id: `merge:${sha}`,
      type: 'merge',
      at: Number(ts) * 1000,
      ref: num ? `!${num[1]}` : sha.slice(0, 7),
      detail: subject,
      author,
      factor: 1,
    });
  }
  return events;
}

function readRemoteRefs(dir) {
  const out = git(dir, ['for-each-ref', `--format=%(refname)${US}%(objectname)`, 'refs/remotes']);
  const map = {};
  if (!out) return map;
  for (const line of out.split('\n')) {
    const [ref, sha] = line.split(US);
    if (ref && sha) map[ref] = sha;
  }
  return map;
}

/**
 * Remote-tracking refs move on both push and fetch. The ref's own reflog
 * records which one it was, so a teammate's fetched work is not stolen valour.
 */
function refMovedByPush(dir, ref) {
  const out = git(dir, ['reflog', 'show', '-n', '1', `--format=%gs${US}%ct`, ref], 5000);
  if (!out) return { push: true, at: 0, known: false };
  const [subject, ts] = out.split('\n')[0].split(US);
  return {
    push: /push/i.test(subject || ''),
    at: Number(ts || 0) * 1000,
    known: true,
  };
}

function readPushes(dir, previous) {
  const current = readRemoteRefs(dir);
  const events = [];
  for (const [ref, sha] of Object.entries(current)) {
    if (previous[ref] === sha) continue;
    if (/\/HEAD$/.test(ref)) continue;
    const info = refMovedByPush(dir, ref);
    if (!info.push) continue;
    events.push({
      id: `push:${ref}:${sha}`,
      type: 'push',
      at: info.at || Date.now(),
      ref: ref.replace('refs/remotes/', ''),
      detail: `pushed to ${ref.replace('refs/remotes/', '')} @ ${sha.slice(0, 7)}`,
      factor: 1,
    });
  }
  return { events, refs: current };
}

function readTags(dir, previous) {
  const out = git(dir, ['for-each-ref', `--format=%(refname:short)${US}%(creatordate:unix)`, 'refs/tags']);
  const names = [];
  const events = [];
  const seen = new Set(previous || []);
  if (out) {
    for (const line of out.split('\n')) {
      const [name, ts] = line.split(US);
      if (!name) continue;
      names.push(name);
      if (!seen.has(name)) {
        events.push({
          id: `tag:${name}`,
          type: 'tag',
          at: Number(ts || 0) * 1000 || Date.now(),
          ref: name,
          detail: `tagged ${name}`,
          factor: 1,
        });
      }
    }
  }
  return { events, tags: names };
}

/**
 * Scans one repository and returns the events found plus the cursor to persist.
 * The first scan only records a baseline, so adopting a pet next to a decade of
 * history does not instantly max it out.
 */
function scanRepo(dir, cursor, now = Date.now()) {
  const result = { events: [], cursor: { ...cursor }, seeded: false, error: null };
  if (!available()) {
    result.error = 'git is not installed or not on PATH';
    return result;
  }
  if (!isRepo(dir)) {
    result.error = 'not a git repository (moved or deleted?)';
    return result;
  }

  const mine = identity(dir).email || null;
  const seeding = !cursor.seededAt;
  const lookback = TUNING.commitLookbackMin * 60 * 1000;
  const since = new Date(Math.max(0, (cursor.lastScanMs || now) - lookback)).toISOString();

  const pushes = readPushes(dir, cursor.remoteRefs || {});
  const tags = readTags(dir, cursor.tags || []);

  result.cursor.remoteRefs = pushes.refs;
  result.cursor.tags = tags.tags;
  result.cursor.lastScanMs = now;

  if (seeding) {
    result.cursor.seededAt = now;
    result.seeded = true;
    return result;
  }

  const repo = shortName(dir);
  const messages = readMessages(dir, since);
  const found = [
    ...readCommits(dir, since, mine, messages),
    ...readMerges(dir, since, mine, messages),
    ...pushes.events,
    ...tags.events,
  ];

  // A squash-merge shows up as both a commit and a merge; the merge id wins.
  const byId = new Map();
  for (const e of found) {
    if (!byId.has(e.id)) byId.set(e.id, { ...e, repo });
  }
  result.events = [...byId.values()].sort((a, b) => a.at - b.at);
  return result;
}

function scanAsync(dir, cursor, now, done) {
  if (!available()) {
    return done({ events: [], cursor, seeded: false, error: 'git is not installed or not on PATH' });
  }
  // Cheap liveness probe first so a dead path fails fast instead of blocking a frame.
  return execFile('git', ['-C', dir, 'rev-parse', '--git-dir'], { timeout: 4000 }, (err) => {
    if (err) return done({ events: [], cursor, seeded: false, error: 'not a git repository (moved or deleted?)' });
    let out;
    try {
      out = scanRepo(dir, cursor, now);
    } catch (e) {
      out = { events: [], cursor, seeded: false, error: e.message };
    }
    done(out);
  });
}

module.exports = {
  available, requireGit, isRepo, repoRoot, identity, recentAuthors,
  scanRepo, scanAsync, shortName, mealFactor,
};
