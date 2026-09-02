'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Watches the parts of .git that change when something worth eating happens,
 * so the pet reacts within a second instead of on the next poll.
 *
 * Non-recursive watches on a fixed set of directories are used deliberately:
 * recursive fs.watch is unavailable on Linux before Node 20, and the set of
 * directories git touches is small and known. Commits write COMMIT_EDITMSG,
 * index and refs/heads/*; pushes write refs/remotes/<remote>/* and their
 * reflogs; tags write refs/tags/* or packed-refs.
 */
const DEBOUNCE_MS = 350;

function gitDirOf(repoPath) {
  const dot = path.join(repoPath, '.git');
  try {
    const st = fs.statSync(dot);
    if (st.isDirectory()) return dot;
    // Worktrees and submodules keep a pointer file instead of a directory.
    const text = fs.readFileSync(dot, 'utf8').trim();
    const m = text.match(/^gitdir:\s*(.+)$/);
    if (m) return path.resolve(repoPath, m[1]);
  } catch { /* not a repo */ }
  return null;
}

function targetsFor(gitDir) {
  const dirs = [
    gitDir,
    path.join(gitDir, 'refs'),
    path.join(gitDir, 'refs', 'heads'),
    path.join(gitDir, 'refs', 'tags'),
    path.join(gitDir, 'refs', 'remotes'),
    path.join(gitDir, 'logs'),
    path.join(gitDir, 'logs', 'refs', 'remotes'),
  ];
  for (const base of [path.join(gitDir, 'refs', 'remotes'), path.join(gitDir, 'logs', 'refs', 'remotes')]) {
    try {
      for (const name of fs.readdirSync(base)) dirs.push(path.join(base, name));
    } catch { /* no remotes yet */ }
  }
  return dirs.filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

class RepoWatcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.handles = new Map();
    this.timer = null;
    this.supported = true;
    this.events = 0;
  }

  add(repoPath) {
    const gitDir = gitDirOf(repoPath);
    if (!gitDir) return false;
    let attached = 0;
    for (const dir of targetsFor(gitDir)) {
      if (this.handles.has(dir)) { attached += 1; continue; }
      try {
        const handle = fs.watch(dir, { persistent: false }, (event, name) => this.bump(dir, name));
        handle.on('error', () => this.drop(dir));
        this.handles.set(dir, handle);
        attached += 1;
      } catch {
        // Some filesystems (network mounts, odd containers) refuse; polling covers them.
      }
    }
    if (!attached) this.supported = false;
    return attached > 0;
  }

  drop(dir) {
    const h = this.handles.get(dir);
    if (h) { try { h.close(); } catch { /* already closed */ } }
    this.handles.delete(dir);
  }

  bump(dir, name) {
    // Lock files come and go on every git write; the real change follows them.
    if (name && /\.lock$/.test(String(name))) return;
    this.events += 1;
    // A new remote appears as a new directory; watch it too.
    if (/refs[\\/]remotes$/.test(dir) && name) {
      const sub = path.join(dir, String(name));
      if (!this.handles.has(sub)) {
        try {
          if (fs.statSync(sub).isDirectory()) {
            const handle = fs.watch(sub, { persistent: false }, (e, n) => this.bump(sub, n));
            handle.on('error', () => this.drop(sub));
            this.handles.set(sub, handle);
          }
        } catch { /* raced with deletion */ }
      }
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, DEBOUNCE_MS);
  }

  get active() {
    return this.handles.size > 0;
  }

  close() {
    clearTimeout(this.timer);
    for (const dir of [...this.handles.keys()]) this.drop(dir);
  }
}

module.exports = { RepoWatcher, gitDirOf, DEBOUNCE_MS };
