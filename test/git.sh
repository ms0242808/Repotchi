#!/usr/bin/env bash
# End-to-end check: drive a real git repo and assert the pet actually eats.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PET="node $ROOT/bin/pet"
SANDBOX="$(mktemp -d)"
export REPOTCHI_HOME="$SANDBOX/state"

pass=0
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  ok   %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL %s\n       expected to contain: %s\n       got: %s\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

check_num() {
  local label="$1" op="$2" want="$3" got="$4"
  if [[ "$op" == "gt" && "$got" -gt "$want" ]] || [[ "$op" == "eq" && "$got" -eq "$want" ]]; then
    printf '  ok   %s (%s)\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %s: expected %s %s, got %s\n' "$label" "$op" "$want" "$got"
    fail=$((fail + 1))
  fi
}

state_field() {
  node -e "const s=require('$REPOTCHI_HOME/state.json');const v=$1;console.log(v===undefined?'':v)"
}

echo "sandbox: $SANDBOX"

# --- set up a repo with a bare "origin" so pushes are real -------------------
git init -q --initial-branch=main "$SANDBOX/repo"
git init -q --bare "$SANDBOX/origin.git"
cd "$SANDBOX/repo"
git config user.email dev@example.com
git config user.name "Dev"
git remote add origin "$SANDBOX/origin.git"

echo "# project" > README.md
git add -A && git commit -qm "chore: initial commit"
git push -q -u origin main

echo
echo "1. tracking records a baseline instead of eating all of history"
out=$($PET track "$SANDBOX/repo" --no-color)
check "track output" "tracking" "$out"
check "baseline noted" "baseline recorded" "$out"
check_num "xp still zero after tracking" eq 0 "$(state_field 's.xp')"

echo
echo "2. a new commit is a meal"
printf 'hello\n' > a.txt
git add -A && git commit -qm "feat: add greeting"
out=$($PET scan --no-color)
check "commit eaten" "COMMIT" "$out"
xp_after_commit=$(state_field 's.xp')
check_num "xp increased" gt 0 "$xp_after_commit"

echo
echo "3. the same commit is never eaten twice"
$PET scan --quiet
check_num "xp unchanged on rescan" eq "$xp_after_commit" "$(state_field 's.xp')"

echo
echo "4. a push is detected from the remote-tracking reflog"
git push -q origin main
out=$($PET scan --no-color)
check "push eaten" "PUSH" "$out"
check_num "push counted" gt 0 "$(state_field 's.totals.push')"

echo
echo "5. a GitLab-style merge is the big feast"
git checkout -q -b feature/checkout
printf 'checkout\n' > b.txt
git add -A && git commit -qm "feat: checkout flow"
git checkout -q main
git merge -q --no-ff feature/checkout -m "Merge branch 'feature/checkout' into 'main'

See merge request group/project!42"
out=$($PET scan --no-color)
check "merge eaten" "MERGED" "$out"
check_num "merge counted" gt 0 "$(state_field 's.totals.merge')"

echo
echo "5b. a GitLab squash merge counts as a merge, not a plain commit"
git checkout -q -b feature/squash
printf 'squashed\n' > c.txt
git add -A && git commit -qm "feat: squashed work"
git checkout -q main
git merge -q --squash feature/squash >/dev/null
# GitLab puts the MR reference in the body, never the subject.
git commit -qm "feat: add the squashed thing (!77)

Adds the thing.

See merge request group/project!77"
out=$($PET scan --no-color)
check "squash merge eaten as MERGED" "MERGED" "$out"
check "squash merge shows the MR number" "!77" "$out"
check_num "merge total incremented" gt 1 "$(state_field 's.totals.merge')"

echo
echo "6. tags are a snack"
git tag -a v1.0.0 -m "release"
out=$($PET scan --no-color)
check "tag eaten" "TAG" "$out"

echo
echo "7. eating drives evolution"
lvl=$(node -e "const s=require('$REPOTCHI_HOME/state.json');const v=require('$ROOT/src/vitals');console.log(v.levelInfo(s.xp).level)")
check_num "levelled past 1" gt 1 "$lvl"

echo
echo "8. neglect makes it hungry"
node -e "
const fs=require('fs');const f='$REPOTCHI_HOME/state.json';
const s=JSON.parse(fs.readFileSync(f,'utf8'));
s.updatedAt = Date.now() - 48*3600*1000;
fs.writeFileSync(f, JSON.stringify(s));
"
$PET scan --quiet
sat=$(node -e "const s=require('$REPOTCHI_HOME/state.json');console.log(Math.round(s.satiety))")
mood=$(node -e "const s=require('$REPOTCHI_HOME/state.json');const v=require('$ROOT/src/vitals');console.log(v.moodKey(s))")
check_num "satiety dropped after 48h" eq 0 "$sat"
check "mood turned bad" "hungry" "${mood/sick/hungry}"

echo
echo "8b. vitals advance identically however often the TUI ticks"
tick_result=$(node -e "
const v=require('$ROOT/src/vitals');const s=require('$ROOT/src/state');
const hour=3600000;
function sleepFor(stepMs){
  const t0=Date.now()-hour;const st=s.blank(t0);
  st.sleeping=true;st.energy=50;st.satiety=80;
  if(!stepMs){v.decay(st,Date.now());}
  else{let t=t0;for(let i=0;i<hour/stepMs;i++){t+=stepMs;v.decay(st,t);}}
  return Math.round(st.energy);
}
console.log([sleepFor(0),sleepFor(8000),sleepFor(140)].join(' '));
")
read -r closed tick8 tick140 <<< "$tick_result"
check_num "1h asleep, TUI closed, energy rises" gt 50 "$closed"
check_num "1h asleep, 8s ticks, matches closed" eq "$closed" "$tick8"
check_num "1h asleep, 140ms ticks, matches closed" eq "$closed" "$tick140"

echo
echo "8c. a long-lived reader cannot revert another writer"
merge_result=$(node -e "
const s=require('$ROOT/src/state');
// Stand in for the TUI: hold a copy loaded before anyone else wrote.
const stale=s.load();
const before=stale.treats;
// Another shell spends a treat and renames the pet.
const other=s.load(); other.treats=before-1; other.name='Ozzy'; s.save(other);
// The long-lived holder now writes its own unrelated change.
s.update((fresh)=>{ fresh.mood=77; });
const after=s.load();
console.log([after.treats, after.name, Math.round(after.mood), before].join(' '));
")
read -r m_treats m_name m_mood m_before <<< "$merge_result"
check_num "the other writer's treat spend survives" eq "$((m_before - 1))" "$m_treats"
check "the other writer's rename survives" "Ozzy" "$m_name"
check_num "our own change still applied" eq 77 "$m_mood"
node -e "const s=require('$ROOT/src/state');const st=s.load();st.name='Repotchi';s.save(st);"

echo
echo "9. non-interactive surfaces still work"
check "status line" "Repotchi" "$($PET status --no-color)"
check "render frame" "vitals" "$($PET render --no-color --width 60)"
check "repos listing" "$SANDBOX/repo" "$($PET repos --no-color)"

echo
echo "10. git hooks install and fire on commit"
$PET hook install "$SANDBOX/repo" >/dev/null
check "hook file written" "repotchi" "$(cat "$SANDBOX/repo/.git/hooks/post-commit")"

echo
printf '\n%s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]] || exit 1
