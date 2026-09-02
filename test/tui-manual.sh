#!/usr/bin/env bash
# Interactive validation driven through tmux. Not part of `npm test` because it
# needs a real pty; run it by hand (or in CI with tmux available) to prove the
# TUI actually works rather than merely rendering correct strings.
#
#   bash test/tui-manual.sh
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMUX_BIN="tmux"
[[ -f /exec-daemon/tmux.portal.conf ]] && TMUX_BIN="tmux -f /exec-daemon/tmux.portal.conf"
command -v tmux >/dev/null || { echo "tmux is required for this suite"; exit 0; }

SANDBOX="$(mktemp -d)"
export REPOTCHI_HOME="$SANDBOX/state"
SESSION="repotchi-tui-$$"

# A repo with enough history to make the panel interesting.
git init -q --initial-branch=main "$SANDBOX/repo"
git init -q --bare --initial-branch=main "$SANDBOX/origin.git"
cd "$SANDBOX/repo"
git config user.email dev@example.com && git config user.name Dev
git remote add origin "$SANDBOX/origin.git"
echo hi > a.txt && git add -A && git commit -qm "chore: init" && git push -q -u origin main
$PET track "$SANDBOX/repo" >/dev/null
for i in 1 2 3; do echo "$i" >> a.txt; git add -A; git commit -qm "feat: step $i"; done
git push -q origin main
$PET scan --quiet

start() {
  $TMUX_BIN kill-session -t "$SESSION" 2>/dev/null
  # The shell outlives the pet so the terminal can still be inspected after it
  # exits; otherwise the session disappears along with the evidence.
  $TMUX_BIN new-session -d -s "$SESSION" -c "$SANDBOX/repo" -- \
    bash -lc "export TERM=xterm-256color REPOTCHI_HOME='$REPOTCHI_HOME'; node $ROOT/bin/pet ${1:-}; echo PET_EXITED; sleep 30"
  sleep 1
  $TMUX_BIN resize-window -t "$SESSION" -x "${2:-96}" -y "${3:-40}" 2>/dev/null
  sleep 2.5
}
press() { $TMUX_BIN send-keys -t "$SESSION:0.0" "$1"; sleep "${2:-1.5}"; }
screen() { $TMUX_BIN capture-pane -p -t "$SESSION:0.0"; }
stop() { $TMUX_BIN kill-session -t "$SESSION" 2>/dev/null; true; }
alt_on() { $TMUX_BIN display -p -t "$SESSION:0.0" '#{alternate_on}' 2>/dev/null; }
cursor_on() { $TMUX_BIN display -p -t "$SESSION:0.0" '#{cursor_flag}' 2>/dev/null; }

widths_uniform() {
  screen > /tmp/tuiframe.txt
  node -e "
  const fs = require('fs');
  const rows = fs.readFileSync('/tmp/tuiframe.txt', 'utf8').split('\n')
    .filter((l) => /^[\u256d\u2502\u2570\u251c]/.test(l));
  const w = new Set(rows.map((l) => [...l].length));
  console.log(rows.length > 4 && w.size === 1 ? 'UNIFORM' : 'RAGGED ' + [...w].join(','));
  "
}

section "1. the pet panel comes up"
start "" 96 40
check "the panel is drawn" "Repotchi" "$(screen)"
check "vitals are shown" "satiety" "$(screen)"
check "the activity sparkline is present" "today" "$(screen)"
check "the badges row is present" "badges" "$(screen)"
check "the key hints are present" "[q]uit" "$(screen)"
check "rows all match" "UNIFORM" "$(widths_uniform)"

section "2. every screen is reachable and returns"
press "i"
check "[i] opens stats" "lifetime meals" "$(screen)"
check "stats lists evolution" "Rebase Phoenix" "$(screen)"
check "stats rows align" "UNIFORM" "$(widths_uniform)"
press "i"
check "[i] returns to the pet" "recently eaten" "$(screen)"
press "?"
check "[?] opens help" "what feeds it" "$(screen)"
check "help mentions doctor" "pet doctor" "$(screen)"
press " "
check "any key leaves help" "recently eaten" "$(screen)"

section "3. the interactive actions respond"
press "p"
check "[p]lay gives feedback" "wiggling" "$(screen)"
press "f"
check "[f]eed gives feedback" "nom" "$(screen)"
press "s"
check "[s]leep announces lights out" "lights out" "$(screen)"
press "s"
check "[s]leep again wakes it" "good morning" "$(screen)"
press "n"
check "[n]ame opens the prompt" "enter to save" "$(screen)"
press "Escape"
check "escape cancels the rename" "watching" "$(screen)"

section "4. it eats while you watch, and it eats fast"
check "the status row reports live watching" "live" "$(screen)"
(cd "$SANDBOX/repo" && echo live >> a.txt && git add -A && git commit -qm "feat: eaten live" >/dev/null)
t0=$(date +%s%N)
found=no
for _ in $(seq 1 60); do
  screen | grep -q "eaten live" && { found=yes; break; }
  sleep 0.1
done
elapsed=$(( ($(date +%s%N) - t0) / 1000000 ))
check "a commit made during the session is eaten" "yes" "$found"
check_num "and within two seconds, not on the next poll (ms)" lt 2000 "$elapsed"

section "4c. the road row says what comes next"
check "road strip is drawn" "road" "$(screen)"
check "and names the next stage with xp to go" "xp" "$(screen | grep road)"

section "4d. a wide terminal gets two columns"
$TMUX_BIN resize-window -t "$SESSION" -x 132 -y 40 2>/dev/null; sleep 2
check "two panels side by side" "recently eaten" "$(screen | head -1)"
check_num "two top-left corners on the first row" eq 2 "$(screen | head -1 | grep -o $'\u256d' | wc -l)"
check "rows stay uniform in two-column mode" "UNIFORM" "$(widths_uniform)"
$TMUX_BIN resize-window -t "$SESSION" -x 96 -y 40 2>/dev/null; sleep 1.5
check_num "narrowing returns to one column" eq 1 "$(screen | head -1 | grep -o $'\u256d' | wc -l)"

section "4e. changing stage plays the evolution"
node -e "
const s = require('$ROOT/src/state'); const v = require('$ROOT/src/vitals');
process.env.REPOTCHI_HOME = '$REPOTCHI_HOME';
s.update((st) => { st.xp = v.xpToReachLevel(3) - 5; });
"
press "r" 2.5
(cd "$SANDBOX/repo" && git checkout -q -b feature/hatch && echo h > h.txt && git add -A && git commit -qm "feat: hatch" \
  && git checkout -q main && git merge -q --no-ff feature/hatch -m "Merge branch 'feature/hatch' into 'main'

See merge request t/t!5")
saw_evolving=no; saw_new=no
for _ in $(seq 1 80); do
  f=$(screen)
  grep -q "evolving" <<< "$f" && saw_evolving=yes
  grep -q "lv 3" <<< "$f" && grep -q "Blip" <<< "$f" && saw_new=yes
  [[ "$saw_evolving" == yes && "$saw_new" == yes ]] && break
  sleep 0.1
done
check "the transition is shown" "yes" "$saw_evolving"
check "and it lands as the new stage" "yes" "$saw_new"
sleep 4

section "4f. the creature itself reacts, not just the toast"
# Now that it has hatched it has a face to react with. Reactions alternate
# between two faces every 280ms, so sample the whole reaction window.
saw_face() { # key pattern
  $TMUX_BIN send-keys -t "$SESSION:0.0" "$1"
  for _ in $(seq 1 12); do
    screen | sed -n '3,7p' | grep -qE "$2" && { echo yes; return; }
    sleep 0.1
  done
  echo no
}
# It just ate a merge, so it is full and would refuse. Make it hungry first.
node -e "
const s = require('$ROOT/src/state');
process.env.REPOTCHI_HOME = '$REPOTCHI_HOME';
s.update((st) => { st.satiety = 40; });
"
sleep 2.5
check "feeding squeezes its eyes and opens its mouth" "yes" "$(saw_face f '>.*<|  O  ')"
sleep 1.6
check "playing makes it grin" "yes" "$(saw_face p '\^.*\^.*|  D  ')"
sleep 1.6
# And when it is full, the refusal shows on its face, not only in the toast.
node -e "
const s = require('$ROOT/src/state');
process.env.REPOTCHI_HOME = '$REPOTCHI_HOME';
s.update((st) => { st.satiety = 100; });
"
sleep 2.5
check "refusing food puffs its cheeks" "yes" "$(saw_face f '=.*=')"
sleep 1.6

section "4g. [c] cycles the frame colour and remembers it"
frame_code() { $TMUX_BIN capture-pane -e -p -t "$SESSION:0.0" | head -1 | grep -o $'\e\[[0-9;]*m' | head -2 | tr -d '\033[' | tr '\n' '+'; }
press "c" 0.6
check "first press announces red" "frame red" "$(screen)"
check "and the frame is dim red" "2m+31m+" "$(frame_code)"
press "c" 0.6
check "second press is green" "2m+32m+" "$(frame_code)"
check "the keys row advertises it" "[c]olor" "$(screen)"
check "the choice is saved on disk" "green" "$(REPOTCHI_HOME=$REPOTCHI_HOME $PET config frame --no-color)"
REPOTCHI_HOME=$REPOTCHI_HOME $PET config frame mood --no-color >/dev/null

section "5. narrow terminals degrade instead of wrapping"
$TMUX_BIN resize-window -t "$SESSION" -x 38 -y 24 2>/dev/null; sleep 2
check "compact view appears" "terminal too narrow" "$(screen)"
over=$(screen | node -e "
let s = ''; process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => console.log(s.split('\n').filter((l) => [...l].length > 38).length));
")
check_num "nothing overflows the window" eq 0 "$over"
$TMUX_BIN resize-window -t "$SESSION" -x 96 -y 40 2>/dev/null; sleep 2
check "widening restores the panel" "satiety" "$(screen)"
check "and it is still uniform" "UNIFORM" "$(widths_uniform)"

section "5b. the key hints survive every common terminal height"
# The classic 80x24 used to cut off the status row and key hints entirely.
for h in 24 28 32 40; do
  $TMUX_BIN resize-window -t "$SESSION" -x 80 -y "$h" 2>/dev/null; sleep 2
  f=$(screen)
  check "80x$h shows the key hints" "[q]" "$f"
  check "80x$h shows the status row" "watching" "$f"
  check "80x$h closes the panel" "$(printf '\u2570')" "$f"
  used=$(printf '%s\n' "$f" | grep -c .)
  check_num "80x$h fits within the terminal" lt "$h" "$used"
done
$TMUX_BIN resize-window -t "$SESSION" -x 80 -y 20 2>/dev/null; sleep 2
check "80x20 falls back to the compact view" "terminal too short" "$(screen)"
$TMUX_BIN resize-window -t "$SESSION" -x 96 -y 40 2>/dev/null; sleep 2

section "6. quitting restores the terminal"
press "q" 3
check "the shell is visible again" "PET_EXITED" "$(screen)"
check "it says goodbye" "See you after the next commit" "$(screen)"
check_num "left the alternate screen" eq 0 "$(alt_on)"
check_num "cursor is visible again" eq 1 "$(cursor_on)"
stop

section "7. a crash also restores the terminal"
cat > "$SANDBOX/crash.js" <<EOF
const store = require('$ROOT/src/state');
const orig = store.update;
let n = 0;
store.update = function (...args) {
  // The first write is the startup scan; the second is the 10s persist.
  if (++n > 1) throw new Error('simulated disk failure');
  return orig.apply(this, args);
};
require('$ROOT/src/cli').main([]);
EOF
$TMUX_BIN kill-session -t "$SESSION" 2>/dev/null
$TMUX_BIN new-session -d -s "$SESSION" -c "$SANDBOX/repo" -- \
  bash -lc "export TERM=xterm-256color REPOTCHI_HOME='$REPOTCHI_HOME'; node '$SANDBOX/crash.js'; echo CRASH_SHELL_VISIBLE; sleep 40"
sleep 1; $TMUX_BIN resize-window -t "$SESSION" -x 96 -y 40 2>/dev/null
for _ in $(seq 1 60); do screen | grep -q CRASH_SHELL_VISIBLE && break; sleep 0.5; done
check "the shell is visible again after the crash" "CRASH_SHELL_VISIBLE" "$(screen)"
check "the error is reported" "repotchi crashed" "$(screen)"
check_num "not stuck in the alternate screen" eq 0 "$(alt_on || echo 0)"
check_num "cursor restored" eq 1 "$(cursor_on || echo 1)"
stop

finish
