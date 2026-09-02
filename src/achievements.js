'use strict';

const { STAGES } = require('./config');

const stageLevel = (key) => (STAGES.find((s) => s.key === key) || { min: 99 }).min;

/**
 * Each badge is a pure predicate over the pet's state plus the event that just
 * happened, so unlocking is deterministic and replayable.
 */
const ACHIEVEMENTS = [
  {
    id: 'first-bite', name: 'First Bite', icon: '\u2726', ascii: 'o',
    how: 'eat your very first thing',
    test: (s) => s.totals.commit + s.totals.push + s.totals.merge + s.totals.tag > 0,
  },
  {
    id: 'shipper', name: 'Shipper', icon: '\u2739', ascii: '^',
    how: 'land 10 merge requests',
    test: (s) => s.totals.merge >= 10,
  },
  {
    id: 'centurion', name: 'Centurion', icon: '\u273a', ascii: '*',
    how: 'feed it 100 commits',
    test: (s) => s.totals.commit >= 100,
  },
  {
    id: 'release-captain', name: 'Release Captain', icon: '\u2756', ascii: 'P',
    how: 'cut 5 tags',
    test: (s) => s.totals.tag >= 5,
  },
  {
    id: 'week-streak', name: 'Seven Days', icon: '\u2731', ascii: '7',
    how: 'ship something 7 days running',
    test: (s) => s.streak.days >= 7,
  },
  {
    id: 'month-streak', name: 'Thirty Days', icon: '\u2732', ascii: 'Q',
    how: 'ship something 30 days running',
    test: (s) => s.streak.days >= 30,
  },
  {
    id: 'night-owl', name: 'Night Owl', icon: '\u2727', ascii: 'C',
    how: 'commit between midnight and 4am',
    test: (s, e) => Boolean(e) && e.type === 'commit' && new Date(e.at).getHours() < 4,
  },
  {
    id: 'early-bird', name: 'Early Bird', icon: '\u2735', ascii: 'E',
    how: 'commit between 5am and 7am',
    test: (s, e) => {
      if (!e || e.type !== 'commit') return false;
      const h = new Date(e.at).getHours();
      return h >= 5 && h < 8;
    },
  },
  {
    id: 'heavy-meal', name: 'Heavy Meal', icon: '\u2749', ascii: '#',
    how: 'feed it a commit touching 500+ lines',
    test: (s, e) => Boolean(e) && (e.churn || 0) >= 500,
  },
  {
    id: 'juggler', name: 'Juggler', icon: '\u271c', ascii: '=',
    how: 'track 3 repositories at once',
    test: (s) => Object.keys(s.repos).length >= 3,
  },
  {
    id: 'survivor', name: 'Survivor', icon: '\u271a', ascii: '+',
    how: 'nurse it back from being sick',
    test: (s) => Boolean(s.wasSick) && s.health > 60,
  },
  {
    id: 'dragon-tamer', name: 'Dragon Tamer', icon: '\u273b', ascii: 'D',
    how: 'raise it to a Merge Dragon',
    test: (s, e, level) => level >= stageLevel('dragon'),
  },
  {
    id: 'phoenix-rising', name: 'Phoenix Rising', icon: '\u273d', ascii: '@',
    how: 'raise it to a Rebase Phoenix',
    test: (s, e, level) => level >= stageLevel('phoenix'),
  },
];

const BY_ID = new Map(ACHIEVEMENTS.map((x) => [x.id, x]));

/** Returns the badges newly earned by this state, recording them as it goes. */
function check(state, event, level) {
  if (!Array.isArray(state.achievements)) state.achievements = [];
  const earned = new Set(state.achievements);
  const fresh = [];
  for (const badge of ACHIEVEMENTS) {
    if (earned.has(badge.id)) continue;
    let hit = false;
    try {
      hit = Boolean(badge.test(state, event, level));
    } catch { hit = false; }
    if (!hit) continue;
    earned.add(badge.id);
    state.achievements.push(badge.id);
    fresh.push(badge);
  }
  return fresh;
}

const get = (id) => BY_ID.get(id) || null;
const all = () => ACHIEVEMENTS.slice();
const glyph = (badge, ascii) => (ascii ? badge.ascii : badge.icon);

module.exports = { ACHIEVEMENTS, check, get, all, glyph };
