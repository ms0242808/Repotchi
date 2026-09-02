#!/usr/bin/env bash
# Produces docs/screenshots/* from real tmux sessions of the running TUI, so
# every picture is of the actual program rather than a mock-up.
#
#   bash tools/screenshots.sh            # writes docs/screenshots/*.{svg,png}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/screenshots"
TMUX_BIN="tmux"
[[ -f /exec-daemon/tmux.portal.conf ]] && TMUX_BIN="tmux -f /exec-daemon/tmux.portal.conf"
command -v tmux >/dev/null || { echo "tmux is required"; exit 1; }

SANDBOX="$(mktemp -d)"
export REPOTCHI_HOME="$SANDBOX/state"
SESSION="repotchi-shots-$$"
PET="node $ROOT/bin/pet"
mkdir -p "$OUT"

shot() { # name title
  $TMUX_BIN capture-pane -e -p -t "$SESSION:0.0" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' \
    | node "$ROOT/tools/screenshot.js" --out "$OUT/$1" --title "$2"
}
start() { # cwd cols rows
  $TMUX_BIN kill-session -t "$SESSION" 2>/dev/null || true
  $TMUX_BIN new-session -d -s "$SESSION" -c "$1" -- \
    bash -lc "export TERM=xterm-256color REPOTCHI_HOME='$REPOTCHI_HOME'; node $ROOT/bin/pet; sleep 5"
  sleep 0.8
  $TMUX_BIN resize-window -t "$SESSION" -x "$2" -y "$3" 2>/dev/null || true
  sleep 2.2
}
press() { $TMUX_BIN send-keys -t "$SESSION:0.0" "$1"; sleep "${2:-1.2}"; }
stop() { $TMUX_BIN kill-session -t "$SESSION" 2>/dev/null || true; }
screen() { $TMUX_BIN capture-pane -p -t "$SESSION:0.0"; }

# --- a repo with a real remote and a pet with a fortnight of history ---------
git init -q --initial-branch=main "$SANDBOX/repo"
git init -q --bare --initial-branch=main "$SANDBOX/origin.git"
cd "$SANDBOX/repo"
git config user.email dev@example.com && git config user.name Dev
git remote add origin "$SANDBOX/origin.git"
echo hi > README.md && git add -A && git commit -qm "chore: init" && git push -q -u origin main

echo "1/5 onboarding (fresh state, nothing tracked)"
start "$SANDBOX/repo" 84 40
shot onboarding "pet  —  first run"
stop

$PET track "$SANDBOX/repo" >/dev/null
for i in 1 2 3 4 5 6; do echo "$i" >> app.txt; git add -A; git commit -qm "feat: step $i"; done
git push -q origin main
for b in login cart checkout; do
  git checkout -q -b "feature/$b"; echo "$b" > "$b.md"; git add -A; git commit -qm "feat: $b"
  git checkout -q main
  git merge -q --no-ff "feature/$b" -m "Merge branch 'feature/$b' into 'main'

See merge request you/project!$((RANDOM % 90 + 10))"
done
git push -q origin main
git tag -a v0.1.0 -m release
$PET scan --quiet
node -e "
const s = require('$ROOT/src/state'); const v = require('$ROOT/src/vitals');
s.update((st) => {
  st.name = 'Repotchi';
  for (let i = 1; i < 14; i++) v.recordHistory(st, Date.now() - i * 86400000, [0, 26, 60, 14, 0, 47, 88, 33, 7, 0, 52, 19, 40][i - 1] || 0);
  st.streak.days = 5;
});
"

echo "2/5 main panel"
start "$SANDBOX/repo" 84 40
sleep 1
shot panel "pet  —  the main panel"

echo "3/5 stats"
press "i" 1.5
shot stats "pet  —  [i] stats, evolution and badges"
press "i" 1

echo "4/5 wide layout"
$TMUX_BIN resize-window -t "$SESSION" -x 132 -y 40; sleep 2
shot wide "pet  —  two columns on a wide terminal"
$TMUX_BIN resize-window -t "$SESSION" -x 84 -y 40; sleep 1.5

echo "5/5 evolution (one merge away from the next stage)"
# Put it a hair under Pupling, then land a merge and catch the transition.
node -e "
const s = require('$ROOT/src/state'); const v = require('$ROOT/src/vitals');
s.update((st) => { st.xp = v.xpToReachLevel(6) - 12; st.satiety = 70; });
"
press "r" 2
git checkout -q -b feature/evolve && echo evolve > evolve.md && git add -A && git commit -qm "feat: growing up"
git checkout -q main
git merge -q --no-ff feature/evolve -m "Merge branch 'feature/evolve' into 'main'

See merge request you/project!77"
caught=no
for _ in $(seq 1 80); do
  if screen | grep -q "evolving"; then
    # Let the reveal get underway so the new form is partly visible.
    sleep 1.6
    shot evolution "pet  —  evolving into the next stage"
    caught=yes
    break
  fi
  sleep 0.1
done
[[ "$caught" == yes ]] || echo "  (evolution moment not caught; try again)"
sleep 3
shot evolved "pet  —  a moment later"
press "q" 1
stop

echo
echo "written to $OUT:"
ls -1 "$OUT"
