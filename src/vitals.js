'use strict';

const { NUTRITION, DECAY, STAGES, TUNING } = require('./config');
const achievements = require('./achievements');

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * Vitals are stored far finer than they are shown. The open TUI applies decay
 * every few seconds, and one such tick moves a stat by ~0.02; rounding that to
 * a tenth would discard it while updatedAt still advanced, freezing every stat
 * for as long as the pet was on screen.
 */
const store = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Each level costs a flat 36xp more than the last. An exponential curve put the
 * late stages thousands of merge requests away, so nobody would ever see them.
 */
function xpForLevel(level) {
  return 50 + 36 * (level - 1);
}

function levelInfo(xp) {
  let level = 1;
  let spent = 0;
  let need = xpForLevel(1);
  while (xp >= spent + need && level < 99) {
    spent += need;
    level += 1;
    need = xpForLevel(level);
  }
  return { level, into: xp - spent, need, ratio: (xp - spent) / need };
}

function stageFor(level) {
  let stage = STAGES[0];
  for (const s of STAGES) if (level >= s.min) stage = s;
  return stage;
}

/** Total xp needed to have reached `level` from a fresh egg. */
function xpToReachLevel(level) {
  let total = 0;
  for (let l = 1; l < level; l += 1) total += xpForLevel(l);
  return total;
}

/**
 * Where the pet is on its road, what comes next, and how far off it is at the
 * recent pace. Pace is xp per day over the last two weeks of history; with no
 * history there is no estimate rather than a made-up one.
 */
function evolution(state, now = Date.now()) {
  const info = levelInfo(state.xp);
  const current = stageFor(info.level);
  const idx = STAGES.findIndex((s) => s.key === current.key);
  const next = STAGES[idx + 1] || null;
  const xpToNext = next ? Math.max(0, xpToReachLevel(next.min) - state.xp) : 0;

  const recent = activity(state, 14, now);
  const xpPerDay = recent.reduce((n, d) => n + d.xp, 0) / recent.length;
  const etaDays = next && xpPerDay > 0 ? Math.ceil(xpToNext / xpPerDay) : null;

  // Progress through the current stage's own span, for the hatching egg.
  const stageStart = xpToReachLevel(current.min);
  const stageEnd = next ? xpToReachLevel(next.min) : stageStart + 1;
  const stageProgress = Math.max(0, Math.min(1, (state.xp - stageStart) / (stageEnd - stageStart)));

  return {
    level: info.level,
    current,
    next,
    xpToNext,
    etaDays,
    xpPerDay: Math.round(xpPerDay),
    stageProgress,
    road: STAGES.map((s) => ({
      ...s,
      xpAt: xpToReachLevel(s.min),
      reached: info.level >= s.min,
      here: s.key === current.key,
    })),
  };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isYesterday(prevKey, todayKey) {
  if (!prevKey) return false;
  const prev = new Date(`${prevKey}T12:00:00`);
  const today = new Date(`${todayKey}T12:00:00`);
  return Math.round((today - prev) / 86400000) === 1;
}

/** Applies real-world time passing since the last update. */
function decay(state, now = Date.now()) {
  const hours = Math.max(0, (now - (state.updatedAt || now)) / 3600000);
  if (hours <= 0) {
    state.updatedAt = now;
    return state;
  }

  const satietyRate = state.sleeping ? DECAY.satiety * DECAY.sleepSatietyFactor : DECAY.satiety;
  state.satiety = store(clamp(state.satiety - satietyRate * hours));

  if (state.sleeping) {
    state.energy = store(clamp(state.energy + DECAY.sleepEnergyGain * hours));
  } else {
    state.energy = store(clamp(state.energy - DECAY.energy * hours));
  }

  // Mood drifts toward a baseline, but hunger drags the baseline down with it.
  const pull = state.satiety < 25 ? DECAY.moodPull - (25 - state.satiety) : DECAY.moodPull;
  const delta = (pull - state.mood) * Math.min(1, (DECAY.moodRate * hours) / 100);
  state.mood = store(clamp(state.mood + delta));

  if (state.satiety <= 0) {
    state.health = store(clamp(state.health - DECAY.starvingHealth * hours));
  } else if (state.satiety > 45) {
    state.health = store(clamp(state.health + 1.5 * hours));
  }

  // Remembered so nursing it back to health can be recognised later.
  if (state.health <= 25) state.wasSick = true;

  state.updatedAt = now;
  return state;
}

/** Per-day xp, kept for the activity sparkline and trimmed to a month. */
function recordHistory(state, now, xp) {
  if (!state.history || typeof state.history !== 'object') state.history = {};
  const key = dayKey(now);
  state.history[key] = (state.history[key] || 0) + xp;
  const keys = Object.keys(state.history).sort();
  while (keys.length > TUNING.historyDays) delete state.history[keys.shift()];
}

/** Last N days of xp, oldest first, with gaps filled as zero. */
function activity(state, days = TUNING.historyDays, now = Date.now()) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(now - i * 86400000);
    out.push({ day: key, xp: (state.history && state.history[key]) || 0 });
  }
  return out;
}

function pushLog(state, entry) {
  state.log.push(entry);
  if (state.log.length > TUNING.logLimit) state.log = state.log.slice(-TUNING.logLimit);
}

/** Feeds one git event to the pet and records it in the log. */
function nourish(state, event, now = Date.now()) {
  const food = NUTRITION[event.type];
  if (!food) return null;
  const factor = event.factor || 1;

  const gained = {
    satiety: Math.round(food.satiety * factor),
    energy: Math.round(food.energy * factor),
    mood: Math.round(food.mood * factor),
    xp: Math.round(food.xp * factor),
    treats: food.treats,
  };

  const before = levelInfo(state.xp).level;
  state.satiety = store(clamp(state.satiety + gained.satiety));
  state.energy = store(clamp(state.energy + gained.energy));
  state.mood = store(clamp(state.mood + gained.mood));
  state.health = store(clamp(state.health + 2));
  state.xp += gained.xp;
  state.treats += gained.treats;
  state.lastEventAt = now;
  state.totals[event.type] = (state.totals[event.type] || 0) + 1;
  if (event.type === 'merge' || event.type === 'tag') state.lastFeastAt = now;
  if (state.sleeping && event.type !== 'commit') state.sleeping = false;

  const after = levelInfo(state.xp).level;
  pushLog(state, {
    ts: event.at || now,
    type: event.type,
    ref: event.ref || '',
    detail: event.detail || '',
    repo: event.repo || '',
    xp: gained.xp,
  });

  const levelled = after > before ? { from: before, to: after, stage: stageFor(after) } : null;
  if (levelled) {
    pushLog(state, {
      ts: now,
      type: 'level',
      ref: `lv${after}`,
      detail: `evolved into ${stageFor(after).name}`,
      repo: '',
      xp: 0,
    });
  }

  recordHistory(state, now, gained.xp);
  const unlocked = achievements.check(state, event, after);
  for (const badge of unlocked) {
    pushLog(state, {
      ts: now, type: 'badge', ref: badge.name, detail: badge.how, repo: '', xp: 0,
    });
  }
  return { gained, levelled, unlocked };
}

/** Awards one bonus per calendar day of activity and tracks the streak. */
function creditStreak(state, now = Date.now()) {
  const today = dayKey(now);
  if (state.streak.lastDay === today) return null;
  state.streak.days = isYesterday(state.streak.lastDay, today) ? state.streak.days + 1 : 1;
  state.streak.lastDay = today;
  return nourish(state, {
    type: 'streak',
    at: now,
    ref: `${state.streak.days}d`,
    detail: `daily streak: ${state.streak.days} day${state.streak.days === 1 ? '' : 's'}`,
    factor: 1,
  }, now);
}

function moodKey(state, now = Date.now()) {
  if (state.health <= 25) return 'sick';
  if (state.sleeping) return 'sleeping';
  if (now - (state.lastFeastAt || 0) < TUNING.feastWindowMs) return 'ecstatic';
  if (state.satiety <= 12) return 'hungry';
  if (state.energy <= 15) return 'tired';
  if (state.mood >= 75) return 'happy';
  if (state.mood <= 25) return 'sad';
  if (state.satiety <= 30) return 'hungry';
  if (state.mood >= 50) return 'content';
  return 'neutral';
}

const QUIPS = {
  ecstatic: ['MERGE FEAST!!! best day ever', 'shipped! *happy wiggling*', 'that MR tasted incredible'],
  happy: ['the repo is healthy and so am I', 'more of that, please', 'humming along nicely'],
  content: ['a commit or two would be lovely', 'steady work, steady pet', 'we are doing fine'],
  neutral: ['... anything landing today?', 'idle hands, idle pet', 'the diff is quiet'],
  hungry: ['feed me a commit', 'my stomach is rebasing itself', 'even a typo fix would do'],
  sad: ['nothing has shipped in ages', 'is the repo abandoned?', 'I miss the sound of git push'],
  tired: ['running on fumes', 'I need a nap', 'energy is low'],
  sleeping: ['zzz... dreaming of clean merges', 'zzz... no conflicts here', 'zzz...'],
  sick: ['I do not feel well', 'starving. please commit something', 'send help (and a merge request)'],
};

function quip(state, now = Date.now()) {
  const key = moodKey(state, now);
  const pool = QUIPS[key] || QUIPS.neutral;
  // Rotates slowly and deterministically so the line is stable between frames.
  const idx = Math.floor(now / 9000) % pool.length;
  return pool[idx];
}

function snapshot(state, now = Date.now()) {
  const lv = levelInfo(state.xp);
  return {
    level: lv.level,
    xpInto: lv.into,
    xpNeed: lv.need,
    xpRatio: lv.ratio,
    stage: stageFor(lv.level),
    mood: moodKey(state, now),
    quip: quip(state, now),
  };
}

module.exports = {
  clamp, decay, nourish, creditStreak, levelInfo, xpForLevel, xpToReachLevel,
  stageFor, evolution, moodKey, quip, snapshot, dayKey, activity, recordHistory,
};
