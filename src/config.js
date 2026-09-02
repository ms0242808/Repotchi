'use strict';

const os = require('os');
const path = require('path');

function homeDir() {
  if (process.env.REPOTCHI_HOME) return path.resolve(process.env.REPOTCHI_HOME);
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'repotchi');
}

function paths() {
  const home = homeDir();
  return {
    home,
    state: path.join(home, 'state.json'),
    lock: path.join(home, 'state.lock'),
  };
}

/**
 * Nutrition per git event. Merged merge requests are the feast the whole
 * system is tuned around: shipping beats committing.
 */
const NUTRITION = {
  commit: { satiety: 8, energy: 2, mood: 4, xp: 6, treats: 1, label: 'commit' },
  push: { satiety: 14, energy: 6, mood: 8, xp: 14, treats: 1, label: 'push' },
  merge: { satiety: 34, energy: 12, mood: 24, xp: 40, treats: 3, label: 'MERGED' },
  tag: { satiety: 18, energy: 8, mood: 14, xp: 26, treats: 2, label: 'tag' },
  streak: { satiety: 6, energy: 8, mood: 12, xp: 12, treats: 1, label: 'streak' },
};

/** Points lost per real hour of neglect. */
const DECAY = {
  satiety: 4.5,
  energy: 2.0,
  moodPull: 42,
  moodRate: 3.5,
  sleepSatietyFactor: 0.45,
  sleepEnergyGain: 11,
  starvingHealth: 3.0,
};

const STAGES = [
  { min: 1, key: 'egg', name: 'Egg' },
  { min: 3, key: 'blip', name: 'Blip' },
  { min: 6, key: 'pupling', name: 'Pupling' },
  { min: 10, key: 'byte', name: 'Byte Beast' },
  { min: 15, key: 'dragon', name: 'Merge Dragon' },
  { min: 22, key: 'phoenix', name: 'Rebase Phoenix' },
];

const TUNING = {
  scanIntervalMs: 8000,
  watchFallbackMs: 30000,
  frameMs: 140,
  reloadMs: 2000,
  persistMs: 10000,
  feastWindowMs: 25000,
  logLimit: 200,
  ledgerLimit: 4000,
  historyDays: 30,
  sparkDays: 14,
  celebrationMs: 2600,
  commitLookbackMin: 10,
  feedSatiety: 16,
  playMood: 14,
  playEnergy: 12,
};

module.exports = { paths, homeDir, NUTRITION, DECAY, STAGES, TUNING };
