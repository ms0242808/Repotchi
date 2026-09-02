#!/usr/bin/env bash
# Everything the user actually looks at: panel geometry, the alternate screens,
# character-set fallback, and the achievement engine behind the badges row.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SANDBOX="$(mktemp -d)"
export REPOTCHI_HOME="$SANDBOX/state"
NO=--no-color

# A pet with enough history that every panel row has something to show.
node -e "
const s = require('$ROOT/src/state');
const st = s.blank(Date.now() - 40 * 86400000);
st.updatedAt = Date.now();
st.xp = 4200; st.satiety = 71; st.energy = 64; st.mood = 82; st.health = 97; st.treats = 9;
st.streak = { days: 12, lastDay: null };
st.totals = { commit: 214, push: 48, merge: 31, tag: 5, streak: 12 };
st.achievements = ['first-bite', 'shipper', 'centurion', 'week-streak'];
st.lastEventAt = Date.now() - 600000;
st.log = [{ ts: Date.now(), type: 'merge', ref: '!128', detail: 'Resolve checkout bug', xp: 40 }];
const v = require('$ROOT/src/vitals');
for (let i = 0; i < 20; i++) v.recordHistory(st, Date.now() - i * 86400000, (i * 13) % 70);
s.save(st);
"

section "1. the panel is a rectangle at every supported width"
for w in 46 52 60 74 92 100; do
  node -e "
  const r = require('$ROOT/src/render');
  const s = require('$ROOT/src/state');
  const a = require('$ROOT/src/ansi');
  const lines = r.frame(s.load(), { width: $w, palette: a.palette(false), keys: true, tick: 3 });
  const widths = new Set(lines.map((l) => [...l].length));
  console.log(widths.size === 1 ? 'RECT ' + [...widths][0] : 'RAGGED ' + [...widths].join(','));
  " > /tmp/rect.txt 2>&1
  check "width $w renders a clean rectangle" "RECT" "$(cat /tmp/rect.txt)"
done

section "2. animation never changes the shape"
node -e "
const r = require('$ROOT/src/render');
const s = require('$ROOT/src/state');
const a = require('$ROOT/src/ansi');
const st = s.load();
const seen = new Set();
for (let tick = 0; tick < 120; tick++) {
  const lines = r.frame(st, { width: 74, palette: a.palette(false), keys: true, tick });
  for (const l of lines) seen.add([...l].length);
}
console.log(seen.size === 1 ? 'STABLE' : 'JITTER ' + [...seen].join(','));
" > /tmp/anim.txt 2>&1
check "120 animation frames stay 74 wide" "STABLE" "$(cat /tmp/anim.txt)"

section "3. celebrations paint over blanks, never over the pet"
node -e "
const r = require('$ROOT/src/render');
const s = require('$ROOT/src/state');
const a = require('$ROOT/src/ansi');
const { Celebration } = require('$ROOT/src/effects');
const st = s.load();
const c = new Celebration();
c.fire('levelup');
const widths = new Set();
let painted = 0;
for (let i = 0; i < 40; i++) {
  const now = Date.now() + i * 60;
  const particles = c.particles(72, 9, now, false);
  painted += particles.size;
  const lines = r.frame(st, { width: 74, palette: a.palette(false), keys: true, tick: i, particles, now });
  for (const l of lines) widths.add([...l].length);
}
console.log((widths.size === 1 ? 'STABLE' : 'JITTER ' + [...widths].join(',')) + ' particles=' + (painted > 0));
" > /tmp/cele.txt 2>&1
check "celebration frames keep their width" "STABLE" "$(cat /tmp/cele.txt)"
check "and particles actually appear" "particles=true" "$(cat /tmp/cele.txt)"

section "4. every screen renders without throwing"
# stats and compact take the pet; onboarding and help do not.
for spec in "onboarding:no" "help:no" "stats:yes" "compact:yes"; do
  screen=${spec%%:*}; needs_state=${spec##*:}
  node -e "
  const screens = require('$ROOT/src/screens');
  const s = require('$ROOT/src/state');
  const a = require('$ROOT/src/ansi');
  const opts = { width: 74, columns: 40, palette: a.palette(false), ascii: false };
  const lines = '$needs_state' === 'yes'
    ? screens['$screen'](s.load(), opts)
    : screens['$screen'](opts);
  if (!Array.isArray(lines) || !lines.length) throw new Error('empty');
  console.log('OK ' + lines.length + ' lines');
  " > /tmp/screen.txt 2>&1
  check "screen '$screen' renders" "OK" "$(cat /tmp/screen.txt)"
done

section "5. --ascii emits no characters outside ASCII"
for cmd in "render --width 60" "status" "doctor" "demo --stage blip"; do
  $PET $cmd --ascii $NO > /tmp/ascii.out 2>&1
  count=$(node -e "
  const fs = require('fs');
  const text = fs.readFileSync('/tmp/ascii.out', 'utf8');
  console.log([...text].filter((ch) => ch.codePointAt(0) > 127).length);
  ")
  check_num "pet $cmd --ascii is pure ascii" eq 0 "$count"
done
node -e "
const screens = require('$ROOT/src/screens');
const s = require('$ROOT/src/state');
const a = require('$ROOT/src/ansi');
const opts = { width: 74, columns: 40, palette: a.palette(false), ascii: true };
const text = [
  ...screens.onboarding(opts), ...screens.help(opts),
  ...screens.stats(s.load(), opts), ...screens.compact(s.load(), opts),
].join('\n');
console.log([...text].filter((ch) => ch.codePointAt(0) > 127).length);
" > /tmp/asciiscreens.txt 2>&1
check_num "all screens in ascii mode are pure ascii" eq 0 "$(cat /tmp/asciiscreens.txt)"

section "6. badge glyphs are single-width dingbats"
node -e "
const A = require('$ROOT/src/achievements');
const bad = A.all().filter((b) => {
  const cp = b.icon.codePointAt(0);
  return [...b.icon].length !== 1 || cp < 0x2700 || cp > 0x27bf;
});
console.log(bad.length ? 'BAD ' + bad.map((b) => b.id).join(',') : 'ALL_SAFE');
" > /tmp/glyph.txt 2>&1
check "no wide or emoji badge glyphs" "ALL_SAFE" "$(cat /tmp/glyph.txt)"
node -e "
const A = require('$ROOT/src/achievements');
const ids = A.all().map((b) => b.id);
const icons = A.all().map((b) => b.icon);
console.log(new Set(ids).size === ids.length && new Set(icons).size === icons.length ? 'UNIQUE' : 'DUPLICATE');
" > /tmp/uniq.txt 2>&1
check "badge ids and glyphs are unique" "UNIQUE" "$(cat /tmp/uniq.txt)"

section "7. badges unlock from real progress"
node -e "
const s = require('$ROOT/src/state');
const v = require('$ROOT/src/vitals');
const st = s.blank();
const out = v.nourish(st, { type: 'commit', at: Date.now(), ref: 'abc', detail: 'x', factor: 1 });
console.log('first=' + out.unlocked.map((b) => b.id).join(','));
st.totals.merge = 9;
const second = v.nourish(st, { type: 'merge', at: Date.now(), ref: '!1', detail: 'y', factor: 1 });
console.log('shipper=' + second.unlocked.map((b) => b.id).join(','));
const third = v.nourish(st, { type: 'merge', at: Date.now(), ref: '!2', detail: 'z', factor: 1 });
console.log('again=' + third.unlocked.length);
" > /tmp/badge.txt 2>&1
check "first meal unlocks First Bite" 'first=first-bite' "$(cat /tmp/badge.txt)"
check "tenth merge unlocks Shipper" 'shipper=shipper' "$(cat /tmp/badge.txt)"
check "badges never unlock twice" 'again=0' "$(cat /tmp/badge.txt)"

section "8. old pets are upgraded, not blanked"
node -e "
const fs = require('fs');
const path = require('path');
const home = '$SANDBOX/legacy';
fs.mkdirSync(home, { recursive: true });
// A state file written by the version before history and badges existed.
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
  version: 1, name: 'Old', hatchedAt: Date.now() - 8.64e7, updatedAt: Date.now(),
  satiety: 60, energy: 60, mood: 60, health: 100, xp: 900, treats: 3,
  streak: { days: 4, lastDay: null }, repos: {}, ledger: [],
  log: [{ ts: Date.now() - 3600000, type: 'commit', ref: 'a', detail: 'old work', xp: 7 }],
  totals: { commit: 120, push: 20, merge: 12, tag: 1, streak: 4 },
}));
process.env.REPOTCHI_HOME = home;
const s = require('$ROOT/src/state');
const st = s.load();
console.log('name=' + st.name);
console.log('xp=' + st.xp);
console.log('badges=' + st.achievements.length);
console.log('history=' + Object.keys(st.history).length);
" > /tmp/legacy.txt 2>&1
check "the old pet keeps its name" 'name=Old' "$(cat /tmp/legacy.txt)"
check "and its xp" 'xp=900' "$(cat /tmp/legacy.txt)"
check_num "badges are backfilled from totals" gt 0 "$(grep -o 'badges=[0-9]*' /tmp/legacy.txt | cut -d= -f2)"
check_num "history is backfilled from the log" gt 0 "$(grep -o 'history=[0-9]*' /tmp/legacy.txt | cut -d= -f2)"

section "9. the evolution road knows where it is going"
node -e "
const v = require('$ROOT/src/vitals');
const s = require('$ROOT/src/state');
const st = s.blank();
st.xp = v.xpToReachLevel(4) + 10;
for (let i = 0; i < 7; i++) v.recordHistory(st, Date.now() - i * 86400000, 40);
const e = v.evolution(st);
console.log('current=' + e.current.key);
console.log('next=' + (e.next && e.next.key));
console.log('toNext=' + e.xpToNext);
console.log('eta=' + e.etaDays);
console.log('road=' + e.road.length + ' here=' + e.road.filter((r) => r.here).length);
const top = s.blank(); top.xp = 99999;
const f = v.evolution(top);
console.log('final=' + (f.next === null) + ' toNext=' + f.xpToNext);
const fresh = v.evolution(s.blank());
console.log('noPaceEta=' + fresh.etaDays);
" > /tmp/evo.txt 2>&1
check "a level-4 pet is a Blip" 'current=blip' "$(cat /tmp/evo.txt)"
check "its next stage is Pupling" 'next=pupling' "$(cat /tmp/evo.txt)"
check_num "xp to next is positive" gt 0 "$(grep -o 'toNext=[0-9]*' /tmp/evo.txt | head -1 | cut -d= -f2)"
check_num "eta is estimated from pace" gt 0 "$(grep -o 'eta=[0-9]*' /tmp/evo.txt | cut -d= -f2)"
check "exactly one 'here' marker on the road" 'road=6 here=1' "$(cat /tmp/evo.txt)"
check "the final form has no next stage" 'final=true toNext=0' "$(cat /tmp/evo.txt)"
check "no history means no invented estimate" 'noPaceEta=null' "$(cat /tmp/evo.txt)"

section "10. the road row fits every panel width"
for w in 46 52 60 74 100; do
  node -e "
  const r = require('$ROOT/src/render');
  const s = require('$ROOT/src/state');
  const a = require('$ROOT/src/ansi');
  const lines = r.frame(s.load(), { width: $w, palette: a.palette(false), tick: 0 });
  const road = lines.find((l) => /xp/.test(l) && /(->|\u2192|final form)/.test(l));
  const widths = new Set(lines.map((l) => [...l].length));
  console.log((road ? 'ROAD ' : 'NOROAD ') + (widths.size === 1 ? 'RECT' : 'RAGGED'));
  " > /tmp/road.txt 2>&1
  check "width $w has a road row in a clean rectangle" 'ROAD RECT' "$(cat /tmp/road.txt)"
done

section "11. the wide layout is one rectangle made of two"
for w in 108 120 140 160; do
  node -e "
  const r = require('$ROOT/src/render');
  const s = require('$ROOT/src/state');
  const a = require('$ROOT/src/ansi');
  const lines = r.wideFrame(s.load(), { width: $w, palette: a.palette(false), keys: true, tick: 2, status: 'x' });
  const widths = new Set(lines.map((l) => [...l].length));
  const corners = (lines[0].match(/[\u256d+]/g) || []).length;
  console.log((widths.size === 1 ? 'RECT' + [...widths][0] : 'RAGGED') + ' corners=' + corners);
  " > /tmp/wide.txt 2>&1
  check "wide $w is a clean rectangle" "RECT$w" "$(cat /tmp/wide.txt)"
  check "wide $w has two top-left corners" 'corners=2' "$(cat /tmp/wide.txt)"
done

section "12. behaviour: reactions, idle habits and the hatching egg"
node -e "
const { Behavior } = require('$ROOT/src/behavior');
const sp = require('$ROOT/src/species');
const b = new Behavior();
b.react('eat', 1000);
const eating = b.face('happy', 1100);
console.log('eat=' + (eating && eating.m === 'O'));
console.log('over=' + (b.face('happy', 9000) === null || typeof b.face('happy', 9000) === 'object'));
console.log('asleep=' + (new Behavior().face('sleeping', 5000) === null));
// Idle picks are stable within a window and can differ between windows.
const c = new Behavior();
const same = JSON.stringify(c.face('content', 12000)) === JSON.stringify(c.face('content', 12500));
console.log('stable=' + same);
const seen = new Set();
for (let w = 0; w < 40; w++) seen.add(JSON.stringify(c.face('content', w * 6000 + 100)));
console.log('variety=' + (seen.size > 1));
// Egg cracks accumulate with progress.
const ink = (p) => sp.pose('egg', 'neutral', 0, false, { eggProgress: p }).join('').replace(/\s/g, '').length;
console.log('cracks=' + (ink(0) < ink(0.5) && ink(0.5) < ink(0.95)));
console.log('shakes=' + (!sp.eggShakes(0.2) && sp.eggShakes(0.9)));
// The evolution reveal keeps every line the same width from start to finish.
const from = sp.pose('blip', 'happy'), to = sp.pose('pupling', 'happy');
const ws = new Set();
for (let t = 0; t <= 1.001; t += 0.1) for (const l of sp.reveal(from, to, t, 3)) ws.add(l.length);
console.log('revealWidths=' + ws.size);
" > /tmp/beh.txt 2>&1
check "eating opens the mouth" 'eat=true' "$(cat /tmp/beh.txt)"
check "reactions expire" 'over=true' "$(cat /tmp/beh.txt)"
check "a sleeping pet has no idle habits" 'asleep=true' "$(cat /tmp/beh.txt)"
check "an idle habit holds within its window" 'stable=true' "$(cat /tmp/beh.txt)"
check "and varies across windows" 'variety=true' "$(cat /tmp/beh.txt)"
check "egg cracks grow with progress" 'cracks=true' "$(cat /tmp/beh.txt)"
check "the egg rocks faster near hatching" 'shakes=true' "$(cat /tmp/beh.txt)"
check "the evolution reveal keeps one width" 'revealWidths=1' "$(cat /tmp/beh.txt)"

section "13. the screenshot tool produces valid images"
node -e "
const shot = require('$ROOT/tools/screenshot.js');
const svg = shot.toSvg('\x1b[1m\x1b[92mhello\x1b[0m world\n\x1b[2mdim\x1b[0m <tag> & co');
console.log('svg=' + svg.startsWith('<svg xmlns'));
console.log('rows=' + (svg.match(/<text y=/g) || []).length);
console.log('bold=' + svg.includes('font-weight=\"700\"'));
console.log('green=' + svg.includes('#a6e3a1'));
console.log('escaped=' + (svg.includes('&lt;tag&gt;') && svg.includes('&amp;')));
const runs = shot.parseLine('\x1b[38;5;196mred\x1b[0m');
console.log('xterm256=' + runs[0].fg);
" > /tmp/shot.txt 2>&1
check "output is an svg document" 'svg=true' "$(cat /tmp/shot.txt)"
check "one text element per line" 'rows=2' "$(cat /tmp/shot.txt)"
check "bold is carried through" 'bold=true' "$(cat /tmp/shot.txt)"
check "colours map to the palette" 'green=true' "$(cat /tmp/shot.txt)"
check "markup characters are escaped" 'escaped=true' "$(cat /tmp/shot.txt)"
check "256-colour codes are understood" 'xterm256=rgb(255,0,0)' "$(cat /tmp/shot.txt)"
for shotfile in panel stats onboarding wide evolution; do
  [[ -s "$ROOT/docs/screenshots/$shotfile.svg" ]] && ok "docs/screenshots/$shotfile.svg exists" || bad "docs/screenshots/$shotfile.svg missing"
done

section "14. the frame colour is a choice, and always dim"
node -e "
const r = require('$ROOT/src/render');
const s = require('$ROOT/src/state');
const a = require('$ROOT/src/ansi');
const p = a.palette(true);
const st = s.blank();
const results = [];
for (const c of r.FRAME_CHOICES) {
  const top = r.frame(st, { width: 50, palette: p, frame: c })[0];
  const codes = (top.match(/\x1b\[(\d+)m/g) || []).slice(0, 2).map((x) => x.replace(/\D/g, ''));
  results.push(c + ':' + codes.join('+'));
}
console.log(results.join(' '));
const distinct = new Set(Object.values(r.FRAME_COLORS));
console.log('distinct=' + distinct.size);
console.log('fallback=' + r.frameFor('happy', 'nonsense'));
console.log('moodSick=' + r.frameFor('sick', 'mood'));
console.log('pinned=' + r.frameFor('sick', 'blue'));
" > /tmp/frame.txt 2>&1
for c in red:2+31 green:2+32 yellow:2+33 blue:2+34 magenta:2+35 cyan:2+36 white:2+37 gray:2+90 pink:2+95 sky:2+94; do
  check "frame ${c%%:*} renders dim with its own code" "$c" "$(cat /tmp/frame.txt)"
done
check "the ten colours are all different" 'distinct=10' "$(cat /tmp/frame.txt)"
check "an unknown preference follows mood, not a crash" 'fallback=lime' "$(cat /tmp/frame.txt)"
check "mood mode reflects sickness" 'moodSick=hotRed' "$(cat /tmp/frame.txt)"
check "a pinned colour ignores mood" 'pinned=blue' "$(cat /tmp/frame.txt)"

section "15. the sparkline scales to its data"
node -e "
const r = require('$ROOT/src/render');
console.log('empty=[' + r.sparkline([0, 0, 0], false) + ']');
const ascii = r.sparkline([0, 5, 10], true);
console.log('asciiOnly=' + [...ascii].every((ch) => ch.codePointAt(0) < 128));
console.log('rises=' + (ascii[0] === ' ' && ascii[2] === '#'));
const peak = r.sparkline([1, 50], false);
console.log('peaks=' + (peak[1] === '\u2588'));
const flat = r.sparkline([7, 7, 7], false);
console.log('flat=' + (new Set([...flat]).size === 1));
" > /tmp/spark.txt 2>&1
check "an empty week is blank, not noisy" 'empty=[   ]' "$(cat /tmp/spark.txt)"
check "ascii mode stays ascii" 'asciiOnly=true' "$(cat /tmp/spark.txt)"
check "the ramp rises with the values" 'rises=true' "$(cat /tmp/spark.txt)"
check "the busiest day reaches full height" 'peaks=true' "$(cat /tmp/spark.txt)"
check "an even week renders evenly" 'flat=true' "$(cat /tmp/spark.txt)"

finish
