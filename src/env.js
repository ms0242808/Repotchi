'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { paths } = require('./config');

const MIN_NODE_MAJOR = 18;

function nodeInfo() {
  const major = Number(process.versions.node.split('.')[0]);
  return { version: process.versions.node, major, ok: major >= MIN_NODE_MAJOR, min: MIN_NODE_MAJOR };
}

let gitCache = null;

/** Probed once per process: every git call downstream assumes this ran. */
function gitInfo() {
  if (gitCache) return gitCache;
  try {
    const out = execFileSync('git', ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    gitCache = { ok: true, version: out.replace(/^git version /, '') };
  } catch (err) {
    gitCache = { ok: false, version: null, reason: err && err.code === 'ENOENT' ? 'not installed' : 'not runnable' };
  }
  return gitCache;
}

/**
 * Whether the terminal can be trusted with box drawing and braille. Windows
 * consoles and non-UTF-8 locales get the ASCII treatment automatically rather
 * than a screen full of question marks.
 */
function unicodeSupported() {
  if (process.env.REPOTCHI_ASCII) return false;
  const ctype = `${process.env.LC_ALL || ''}${process.env.LC_CTYPE || ''}${process.env.LANG || ''}`;
  if (/UTF-?8/i.test(ctype)) return true;
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM) return true;
  if (process.platform === 'win32') return false;
  // Most modern unix terminals are UTF-8 even when the locale is unset.
  return process.env.TERM !== 'linux' && process.env.TERM !== 'dumb';
}

function terminalInfo(stream = process.stdout) {
  return {
    tty: Boolean(stream && stream.isTTY),
    columns: (stream && stream.columns) || null,
    rows: (stream && stream.rows) || null,
    term: process.env.TERM || '(unset)',
    program: process.env.TERM_PROGRAM || null,
    unicode: unicodeSupported(),
    tooNarrow: Boolean(stream && stream.isTTY && stream.columns && stream.columns < 46),
  };
}

/** Can we actually persist? Probed by writing, because stat lies about ACLs. */
function stateInfo() {
  const p = paths();
  const info = { home: p.home, file: p.state, exists: false, writable: false, error: null, bytes: 0 };
  try {
    const st = fs.statSync(p.state);
    info.exists = true;
    info.bytes = st.size;
  } catch { /* first run */ }

  try {
    fs.mkdirSync(p.home, { recursive: true });
    const probe = path.join(p.home, `.probe.${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    info.writable = true;
  } catch (err) {
    info.error = (err && err.code) || String(err);
  }
  return info;
}

function platformInfo() {
  return {
    platform: process.platform,
    release: os.release(),
    shell: process.env.SHELL || process.env.ComSpec || '(unknown)',
    home: os.homedir(),
  };
}

module.exports = {
  nodeInfo, gitInfo, terminalInfo, stateInfo, platformInfo, unicodeSupported, MIN_NODE_MAJOR,
};
