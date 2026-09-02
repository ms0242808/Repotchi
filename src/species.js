'use strict';

/**
 * Face slots are single characters (@ left eye, # right eye, & mouth) so a pose
 * never changes width when the mood changes. None of these appear in the bodies.
 */
const FACES = {
  happy: { l: '^', r: '^', m: 'w' },
  content: { l: 'o', r: 'o', m: 'u' },
  neutral: { l: 'o', r: 'o', m: '-' },
  hungry: { l: 'O', r: 'O', m: 'o' },
  sad: { l: 'T', r: 'T', m: '.' },
  tired: { l: '-', r: '-', m: '~' },
  sleeping: { l: '-', r: '-', m: '~' },
  sick: { l: 'x', r: 'x', m: '~' },
  ecstatic: { l: '*', r: '*', m: 'D' },
  blink: { l: '-', r: '-', m: 'w' },
};

const ART = {
  egg: [
    [
      '     .-""""-.     ',
      '   .\'        \'.   ',
      '  /            \\  ',
      ' |              | ',
      ' |              | ',
      '  \\            /  ',
      '   \'-.________.-\'  ',
    ],
    [
      '      .-""""-.    ',
      '    .\'        \'.  ',
      '   /            \\ ',
      '  |              |',
      '  |              |',
      '   \\            / ',
      '    \'-.________.-\' ',
    ],
  ],
  blip: [
    [
      '     .-~~~~~~-.     ',
      '   .\'          \'.   ',
      '  /   @      #   \\  ',
      ' |        &        | ',
      '  \\              /  ',
      '   \'-.________.-\'   ',
      '      \'  \'  \'       ',
    ],
    [
      '     .-~~~~~~-.     ',
      '   .\'          \'.   ',
      '  /   @      #   \\  ',
      ' |        &        | ',
      '  \\              /  ',
      '   \'-.________.-\'   ',
      '       \'  \'  \'      ',
    ],
  ],
  pupling: [
    [
      '    /\\________/\\    ',
      '   (   @    #   )   ',
      '    )     &     (   ',
      '   (   \'~~~~\'   )   ',
      '    \\          /    ',
      '    /\\______/\\      ',
      '   (_)      (_)     ',
    ],
    [
      '    /\\________/\\    ',
      '   (   @    #   )   ',
      '    )     &     (   ',
      '   (   \'~~~~\'   )   ',
      '     \\        /     ',
      '     /\\____/\\       ',
      '    (_)    (_)      ',
    ],
  ],
  byte: [
    [
      '   ______________   ',
      '  /|            |\\  ',
      ' | |   @     #  | |  ',
      ' | |      &     | |  ',
      ' | |____________| |  ',
      '  \\|   ||  ||   |/  ',
      '    [__]    [__]    ',
    ],
    [
      '   ______________   ',
      '  /|            |\\  ',
      ' | |   @     #  | |  ',
      ' | |      &     | |  ',
      ' | |____________| |  ',
      '  \\|   ||  ||   |/  ',
      '   [__]      [__]   ',
    ],
  ],
  dragon: [
    [
      '  \\\\            //  ',
      '   \\\\__  ___  __//  ',
      '    \\  \\/   \\/  /   ',
      '     |  @   #  |    ',
      '     |    &    |    ',
      '    / \\_______/ \\   ',
      '   /_/         \\_\\  ',
    ],
    [
      '   \\\\          //   ',
      '    \\\\_  ___  _//   ',
      '     \\ \\/   \\/ /    ',
      '     |  @   #  |    ',
      '     |    &    |    ',
      '    / \\_______/ \\   ',
      '  /_/           \\_\\ ',
    ],
  ],
  phoenix: [
    [
      '   \\   ,     ,   /  ',
      '   \'-.~~~~~~~~~.-\'  ',
      '     /  @   #  \\    ',
      '    |     &     |   ',
      '     \\   \\_/   /    ',
      '    .-\'~     ~\'-.   ',
      '   /   ~  ~  ~   \\  ',
    ],
    [
      '   /   \'     \'   \\  ',
      '   .-~\'\'\'\'\'\'\'\'\'~-.  ',
      '     /  @   #  \\    ',
      '    |     &     |   ',
      '     \\   \\_/   /    ',
      '    \'-.~     ~.-\'   ',
      '   \\   ~  ~  ~   /  ',
    ],
  ],
};

/**
 * Cracks appear on the egg as it approaches hatching, cumulatively by stage,
 * so the first hour shows visible progress instead of a static shell.
 * Each entry is [row, col, char] on the frame-0 egg.
 */
const EGG_CRACKS = [
  { at: 0.15, marks: [[1, 10, '\\']] },
  { at: 0.35, marks: [[2, 10, '\\'], [2, 11, '_']] },
  { at: 0.55, marks: [[3, 11, '/'], [3, 6, '_'], [3, 7, '/']] },
  { at: 0.75, marks: [[4, 5, '/'], [4, 6, '_'], [4, 12, '\\']] },
  { at: 0.9, marks: [[2, 7, '*'], [4, 9, '*']] },
];

/** Floating decorations that sell the mood without redrawing the body. */
const ACCENTS = {
  sleeping: ['z', 'Z', 'z', ' '],
  ecstatic: ['*', '+', '*', '!'],
  happy: ['~', '.', '~', ' '],
  hungry: ['?', '.', '?', ' '],
  sick: ['.', ',', '.', ' '],
};

function normalize(lines) {
  const w = Math.max(...lines.map((l) => l.length));
  return lines.map((l) => l.padEnd(w, ' '));
}

function setChar(line, col, ch) {
  if (col < 0 || col >= line.length) return line;
  return `${line.slice(0, col)}${ch}${line.slice(col + 1)}`;
}

function crackedEgg(lines, progress, frame) {
  // Frame 1 is the same egg shifted one column right.
  const shift = frame % 2;
  let out = lines.slice();
  for (const stage of EGG_CRACKS) {
    if (progress < stage.at) break;
    for (const [row, col, ch] of stage.marks) {
      out[row] = setChar(out[row], col + shift, ch);
    }
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.face]  partial face override {l,r,m}
 * @param {number} [opts.eggProgress]  0..1 progress toward hatching
 */
function pose(stageKey, mood, frame = 0, blinking = false, opts = {}) {
  const frames = ART[stageKey] || ART.blip;
  const base = blinking && mood !== 'sleeping' && mood !== 'sick'
    ? FACES.blink
    : (FACES[mood] || FACES.neutral);
  const face = { ...base, ...(opts.face || {}) };
  let lines = frames[frame % frames.length].map((l) => l
    .replace(/@/g, face.l)
    .replace(/#/g, face.r)
    .replace(/&/g, face.m));
  if (stageKey === 'egg' && typeof opts.eggProgress === 'number') {
    lines = crackedEgg(lines, opts.eggProgress, frame);
  }
  return normalize(lines);
}

/** An egg close to hatching rocks faster. */
const eggShakes = (progress) => progress >= 0.75;

/**
 * The body dissolved into shimmer for the middle of an evolution. Every
 * non-space character becomes a glint that changes with the tick, so the old
 * form is recognisably "there" while clearly no longer itself.
 */
function silhouette(lines, tick, ascii = false) {
  const glints = ascii ? ['*', '+', '.', 'o'] : ['*', '+', '\'', '\u2726'];
  return lines.map((line, row) => line.split('').map((ch, col) => {
    if (ch === ' ') return ' ';
    return glints[(row * 3 + col + tick) % glints.length];
  }).join(''));
}

/** Reveal `to` from the top down over `from`'s silhouette as t goes 0..1. */
function reveal(from, to, t, tick, ascii = false) {
  const ghost = silhouette(from, tick, ascii);
  const rows = Math.max(ghost.length, to.length);
  const cut = Math.floor(t * (rows + 1));
  const width = Math.max(...ghost.map((l) => l.length), ...to.map((l) => l.length));
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const line = i < cut ? (to[i] || '') : (ghost[i] || '');
    out.push(line.padEnd(width, ' '));
  }
  return out;
}

function accent(mood, tick) {
  const pool = ACCENTS[mood];
  if (!pool) return '';
  return pool[Math.floor(tick / 3) % pool.length];
}

/** One blink per 24 ticks, offset so a still frame never catches closed eyes. */
const isBlinking = (tick) => tick % 24 === 17;

const stageKeys = () => Object.keys(ART);

module.exports = {
  pose, accent, isBlinking, stageKeys, normalize, silhouette, reveal, eggShakes,
  FACES, ART, EGG_CRACKS,
};
