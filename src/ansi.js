'use strict';

const CSI = '\x1b[';
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const FG = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, hotRed: 91, lime: 92, gold: 93, sky: 94, pink: 95, aqua: 96, snow: 97,
};

const ATTR = { bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7 };

function wrap(open, text) {
  return `${CSI}${open}m${text}${CSI}0m`;
}

/**
 * Builds a palette whose functions are transparent no-ops when colour is off,
 * so render code never has to branch on colour support.
 */
function palette(enabled) {
  const p = {};
  for (const [name, code] of Object.entries(FG)) {
    p[name] = enabled ? (t) => wrap(code, t) : (t) => t;
  }
  for (const [name, code] of Object.entries(ATTR)) {
    p[name] = enabled ? (t) => wrap(code, t) : (t) => t;
  }
  p.enabled = enabled;
  p.on = (fg, t) => (enabled && FG[fg] ? wrap(FG[fg], t) : t);
  return p;
}

const strip = (s) => String(s).replace(ANSI_RE, '');
const width = (s) => strip(s).length;

function pad(s, w) {
  const gap = w - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

function padStart(s, w) {
  const gap = w - width(s);
  return gap > 0 ? ' '.repeat(gap) + s : s;
}

function center(s, w) {
  const gap = w - width(s);
  if (gap <= 0) return s;
  const left = Math.floor(gap / 2);
  return ' '.repeat(left) + s + ' '.repeat(gap - left);
}

/** Truncate plain text before colouring; never cuts an escape sequence in half. */
function clip(s, w, ellipsis = '\u2026') {
  const plain = strip(s);
  if (plain.length <= w) return s;
  if (w <= 1) return plain.slice(0, Math.max(0, w));
  return plain.slice(0, w - 1) + ellipsis;
}

const screen = {
  altOn: `${CSI}?1049h`,
  altOff: `${CSI}?1049l`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  home: `${CSI}H`,
  clear: `${CSI}2J`,
  clearBelow: `${CSI}J`,
  clearLine: `${CSI}K`,
  to: (row, col) => `${CSI}${row};${col}H`,
};

/** Colour is opt-out on a real terminal and opt-in everywhere else. */
function supportsColor(stream, flags = {}) {
  if (flags.noColor) return false;
  if (flags.color) return true;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== '0';
  if (!stream || !stream.isTTY) return false;
  const term = process.env.TERM || '';
  return term !== '' && term !== 'dumb';
}

module.exports = { palette, strip, width, pad, padStart, center, clip, screen, supportsColor, FG };
