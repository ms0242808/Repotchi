'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');
const git = require('./git');
const store = require('./state');

/**
 * Every check returns one of ok / warn / fail plus, when something is wrong, a
 * concrete next action. These exist because each of them was, at some point, a
 * failure the tool suffered in complete silence.
 */

function checkNode() {
  const n = env.nodeInfo();
  return n.ok
    ? { level: 'ok', label: 'node', detail: `v${n.version}` }
    : { level: 'fail', label: 'node', detail: `v${n.version} is too old`, fix: `install Node ${n.min} or newer` };
}

function checkGit() {
  const g = env.gitInfo();
  return g.ok
    ? { level: 'ok', label: 'git', detail: g.version }
    : { level: 'fail', label: 'git', detail: g.reason, fix: 'install git and make sure it is on your PATH' };
}

function checkState() {
  const s = env.stateInfo();
  if (!s.writable) {
    return {
      level: 'fail',
      label: 'state',
      detail: `cannot write ${s.home} (${s.error})`,
      fix: 'set REPOTCHI_HOME to a writable directory',
    };
  }
  const size = s.exists ? `${(s.bytes / 1024).toFixed(1)} kB` : 'not created yet';
  return { level: 'ok', label: 'state', detail: `${s.file} (${size})` };
}

function checkTerminal() {
  const t = env.terminalInfo();
  if (!t.tty) {
    return { level: 'ok', label: 'terminal', detail: 'not a tty (fine for scan/status in scripts)' };
  }
  if (t.tooNarrow) {
    return {
      level: 'warn',
      label: 'terminal',
      detail: `${t.columns} columns is narrower than the 46 the panel needs`,
      fix: 'widen the window, or use `pet status` instead of the full TUI',
    };
  }
  const charset = t.unicode ? 'unicode' : 'ascii (auto-detected)';
  return { level: 'ok', label: 'terminal', detail: `${t.columns}x${t.rows} ${t.term}, ${charset}` };
}

/**
 * The headline check. A pet fed by an email that does not match the commits
 * arriving in the repo starves without ever explaining why.
 */
function checkRepo(repoPath, cursor) {
  const name = path.basename(repoPath);
  if (!git.isRepo(repoPath)) {
    return [{
      level: 'fail',
      label: name,
      detail: `${repoPath} is not a git repository any more`,
      fix: `pet untrack ${repoPath}`,
    }];
  }

  const out = [];
  const mine = git.identity(repoPath).email;
  const authors = git.recentAuthors(repoPath);

  if (!mine) {
    out.push({
      level: 'warn',
      label: name,
      detail: 'no user.email configured, so every author counts',
      fix: `git -C ${repoPath} config user.email you@example.com`,
    });
  } else {
    const mismatched = authors.filter((a) => a.email !== mine);
    const matched = authors.find((a) => a.email === mine);
    if (!matched && authors.length) {
      out.push({
        level: 'fail',
        label: name,
        detail: `user.email is ${mine} but no recent commit uses it`,
        fix: `nothing here will ever feed the pet. Recent authors: ${authors.slice(0, 3).map((a) => a.email).join(', ')}`,
      });
    } else if (mismatched.length) {
      const top = mismatched.slice(0, 2).map((a) => `${a.email} (${a.count})`).join(', ');
      out.push({
        level: 'warn',
        label: name,
        detail: `${mismatched.reduce((n, a) => n + a.count, 0)} recent commits are by other authors: ${top}`,
        fix: 'expected on a shared repo; only commits matching your user.email are eaten',
      });
    }
  }

  const hooks = ['post-commit', 'post-merge', 'post-checkout'];
  const installed = hooks.filter((h) => {
    try {
      return fs.readFileSync(path.join(repoPath, '.git', 'hooks', h), 'utf8').includes('repotchi');
    } catch { return false; }
  });
  out.push({
    level: 'ok',
    label: name,
    detail: installed.length
      ? `hooks installed (${installed.join(', ')})`
      : 'no hooks (the TUI still scans every 8s)',
  });

  if (!cursor || !cursor.seededAt) {
    out.push({ level: 'warn', label: name, detail: 'never scanned yet', fix: 'run `pet scan`' });
  }
  return out;
}

function diagnose() {
  const checks = [checkNode(), checkGit(), checkState(), checkTerminal()];
  let state = null;
  try {
    state = store.load();
  } catch (err) {
    checks.push({ level: 'fail', label: 'state', detail: String((err && err.message) || err) });
  }

  const repos = state ? Object.entries(state.repos) : [];
  if (!repos.length) {
    checks.push({
      level: 'warn',
      label: 'repos',
      detail: 'no repositories tracked, so the pet can never eat',
      fix: 'cd into a repo and run `pet track`',
    });
  } else if (env.gitInfo().ok) {
    for (const [repoPath, cursor] of repos) checks.push(...checkRepo(repoPath, cursor));
  }

  const worst = checks.some((c) => c.level === 'fail') ? 'fail'
    : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  return { checks, worst, state };
}

module.exports = { diagnose };
