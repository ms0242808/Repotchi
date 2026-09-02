#!/usr/bin/env node
'use strict';

/**
 * Turns an ANSI-coloured terminal capture into an SVG image, and a PNG when a
 * headless Chrome is available. Used to produce docs/screenshots from real
 * tmux sessions, so the pictures are of the thing that actually runs.
 *
 *   node tools/screenshot.js --in frame.ansi --out docs/screenshots/panel
 *   tmux capture-pane -e -p | node tools/screenshot.js --out shot
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const PALETTE = {
  30: '#45475a', 31: '#f38ba8', 32: '#a6e3a1', 33: '#f9e2af',
  34: '#89b4fa', 35: '#f5c2e7', 36: '#94e2d5', 37: '#cdd6f4',
  90: '#7f849c', 91: '#f38ba8', 92: '#a6e3a1', 93: '#f9e2af',
  94: '#89b4fa', 95: '#f5c2e7', 96: '#94e2d5', 97: '#ffffff',
};
const DEFAULT_FG = '#cdd6f4';
const BG = '#1e1e2e';
const FONT_SIZE = 14;
const CHAR_W = 8.43;
const LINE_H = 19;
const PAD = 18;

function args(argv) {
  const out = { in: null, out: null, title: null, png: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in') out.in = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--title') out.title = argv[++i];
    else if (argv[i] === '--no-png') out.png = false;
  }
  if (!out.out) {
    process.stderr.write('usage: screenshot.js [--in file] --out basename [--title text] [--no-png]\n');
    process.exit(2);
  }
  return out;
}

/** Splits one line of ANSI text into runs of {text, fg, bold, dim, italic}. */
function parseLine(line) {
  const runs = [];
  let style = { fg: null, bold: false, dim: false, italic: false };
  let buf = '';
  const flush = () => { if (buf) { runs.push({ text: buf, ...style }); buf = ''; } };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    buf += line.slice(last, m.index);
    flush();
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) style = { fg: null, bold: false, dim: false, italic: false };
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 22) { style.bold = false; style.dim = false; }
      else if (c === 23) style.italic = false;
      else if (c === 39) style.fg = null;
      else if (PALETTE[c]) style.fg = PALETTE[c];
      else if (c === 38 && codes[i + 1] === 5) { style.fg = xterm256(codes[i + 2]); i += 2; }
      else if (c === 38 && codes[i + 1] === 2) { style.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
    }
    last = re.lastIndex;
  }
  buf += line.slice(last);
  flush();
  return runs;
}

function xterm256(n) {
  if (n < 16) return PALETTE[n < 8 ? 30 + n : 90 + (n - 8)] || DEFAULT_FG;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  const r = Math.floor(i / 36) % 6; const g = Math.floor(i / 6) % 6; const b = i % 6;
  const s = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${s(r)},${s(g)},${s(b)})`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toSvg(text, title) {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim()) lines.pop();
  const parsed = lines.map(parseLine);
  const cols = Math.max(1, ...parsed.map((runs) => [...runs.map((r) => r.text).join('')].length));
  const titleH = title ? 30 : 0;
  const width = Math.ceil(cols * CHAR_W + PAD * 2);
  const height = Math.ceil(lines.length * LINE_H + PAD * 2 + titleH);

  const rows = parsed.map((runs, i) => {
    let col = 0;
    const spans = runs.map((r) => {
      const x = (PAD + col * CHAR_W).toFixed(2);
      col += [...r.text].length;
      const fill = r.fg || DEFAULT_FG;
      const attrs = [
        `x="${x}"`,
        `fill="${fill}"`,
        r.bold ? 'font-weight="700"' : '',
        r.italic ? 'font-style="italic"' : '',
        r.dim ? 'opacity="0.6"' : '',
      ].filter(Boolean).join(' ');
      return `<tspan ${attrs}>${esc(r.text)}</tspan>`;
    }).join('');
    const y = PAD + titleH + (i + 1) * LINE_H - 5;
    return `  <text y="${y}" xml:space="preserve">${spans}</text>`;
  });

  const titleEl = title
    ? `  <text x="${PAD}" y="${PAD + 14}" fill="#7f849c" font-size="12">${esc(title)}</text>\n`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="'JetBrains Mono','Fira Code',Menlo,Consolas,'DejaVu Sans Mono',monospace" font-size="${FONT_SIZE}">
  <rect width="100%" height="100%" rx="10" fill="${BG}"/>
${titleEl}${rows.join('\n')}
</svg>
`;
}

function chromePath() {
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch { /* try the next name */ }
  }
  return null;
}

/**
 * Headless Chrome writes the screenshot within a second or two and then, in
 * containers, often refuses to exit. The file on disk is the source of truth:
 * once it exists and has stopped growing, Chrome is killed.
 */
function toPng(svgPath, pngPath, width, height) {
  const chrome = chromePath();
  if (!chrome) return Promise.resolve(false);

  // A private profile: sharing the default one collides with any Chrome the
  // user already has open, which aborts the launch with a SingletonLock error.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'repotchi-chrome-'));
  // Render to a scratch file and only replace the real one on success, so a
  // failed run can never delete a screenshot that already existed.
  const scratch = `${pngPath}.tmp-${process.pid}.png`;

  const child = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check',
    // A random port: a fixed one inherited from system flags can collide with
    // a browser the user already has open and abort the launch.
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    `--screenshot=${scratch}`,
    `file://${path.resolve(svgPath)}`,
  ], { stdio: 'ignore' });

  const sizeOf = () => { try { return fs.statSync(scratch).size; } catch { return 0; } };
  const cleanup = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (ok) {
        try { fs.renameSync(scratch, pngPath); } catch { ok = false; }
      }
      try { fs.unlinkSync(scratch); } catch { /* already moved or never written */ }
      cleanup();
      resolve(ok);
    };
    const started = Date.now();
    let lastSize = -1;
    const timer = setInterval(() => {
      const size = sizeOf();
      const stable = size > 0 && size === lastSize;
      lastSize = size;
      if (stable || Date.now() - started > 20000) finish(size > 0);
    }, 250);
    child.on('exit', () => finish(sizeOf() > 0));
    child.on('error', () => finish(false));
  });
}

async function main() {
  const opts = args(process.argv.slice(2));
  const input = opts.in ? fs.readFileSync(opts.in, 'utf8') : fs.readFileSync(0, 'utf8');
  const svg = toSvg(input, opts.title);
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const svgPath = `${opts.out}.svg`;
  fs.writeFileSync(svgPath, svg);
  let made = `${svgPath}`;
  if (opts.png) {
    const pngPath = `${opts.out}.png`;
    try {
      // Chrome occasionally aborts on launch when another instance is busy;
      // one retry after a pause covers it without hiding a real failure.
      let ok = await toPng(svgPath, pngPath, Number(w), Number(h));
      if (!ok) {
        await new Promise((r) => setTimeout(r, 750));
        ok = await toPng(svgPath, pngPath, Number(w), Number(h));
      }
      if (ok) made += ` ${pngPath}`;
      else process.stderr.write('png skipped: headless chrome did not produce an image\n');
    } catch { /* png is a bonus; the svg is the deliverable */ }
  }
  process.stdout.write(`${made}\n`);
}

if (require.main === module) main();
module.exports = { toSvg, parseLine, toPng, chromePath };
