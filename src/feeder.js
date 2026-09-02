'use strict';

const git = require('./git');
const vitals = require('./vitals');

/** Applies one repo's scan result to the pet, skipping anything already eaten. */
function ingest(state, repoPath, scan, now) {
  const out = { fed: [], levelled: [], unlocked: [], seeded: scan.seeded, error: scan.error };
  if (scan.error) return out;

  state.repos[repoPath] = scan.cursor;
  if (scan.seeded) return out;

  const eaten = new Set(state.ledger);
  for (const event of scan.events) {
    if (eaten.has(event.id)) continue;
    eaten.add(event.id);
    state.ledger.push(event.id);
    const result = vitals.nourish(state, event, now);
    if (!result) continue;
    out.fed.push({ event, gained: result.gained });
    if (result.levelled) out.levelled.push(result.levelled);
    if (result.unlocked) out.unlocked.push(...result.unlocked);
  }

  if (out.fed.length) {
    const bonus = vitals.creditStreak(state, now);
    if (bonus && bonus.levelled) out.levelled.push(bonus.levelled);
    if (bonus && bonus.unlocked) out.unlocked.push(...bonus.unlocked);
    if (bonus) out.fed.push({ event: { type: 'streak', ref: `${state.streak.days}d`, detail: 'daily streak' }, gained: bonus.gained });
  }
  return out;
}

function scanAll(state, now = Date.now()) {
  vitals.decay(state, now);
  const summary = { fed: [], levelled: [], unlocked: [], seeded: [], errors: [] };
  for (const [repoPath, cursor] of Object.entries(state.repos)) {
    const scan = git.scanRepo(repoPath, cursor, now);
    const res = ingest(state, repoPath, scan, now);
    if (res.error) summary.errors.push({ repo: repoPath, error: res.error });
    if (res.seeded) summary.seeded.push(repoPath);
    summary.fed.push(...res.fed);
    summary.levelled.push(...res.levelled);
    summary.unlocked.push(...res.unlocked);
  }
  return summary;
}

/** Non-blocking variant so the TUI keeps animating while git works. */
function scanAllAsync(state, now, done) {
  vitals.decay(state, now);
  const repos = Object.keys(state.repos);
  const summary = { fed: [], levelled: [], unlocked: [], seeded: [], errors: [] };
  if (!repos.length) return done(summary);

  let pending = repos.length;
  for (const repoPath of repos) {
    git.scanAsync(repoPath, state.repos[repoPath], now, (scan) => {
      const res = ingest(state, repoPath, scan, now);
      if (res.error) summary.errors.push({ repo: repoPath, error: res.error });
      if (res.seeded) summary.seeded.push(repoPath);
      summary.fed.push(...res.fed);
      summary.levelled.push(...res.levelled);
      summary.unlocked.push(...res.unlocked);
      if (--pending === 0) done(summary);
    });
  }
}

module.exports = { scanAll, scanAllAsync, ingest };
