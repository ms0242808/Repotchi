#!/usr/bin/env bash
# The command-line surface: bad input, broken environments, and diagnostics.
# Every case here is a failure the tool once suffered silently or crashed on.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SANDBOX="$(mktemp -d)"
export REPOTCHI_HOME="$SANDBOX/state"
NO=--no-color

section "1. hostile input is refused with an explanation"
check "unknown command names itself" 'unknown command "bogus"' "$($PET bogus $NO 2>&1)"
check "unknown command lists the real ones" 'commands:' "$($PET bogus $NO 2>&1)"
check "unknown option is caught" 'unknown option --frobnicate' "$($PET --frobnicate $NO 2>&1)"
check "non-numeric --width" 'needs a positive number' "$($PET render --width abc $NO 2>&1)"
check "negative --width" 'needs a positive number' "$($PET render --width -5 $NO 2>&1)"
check "non-numeric --interval" 'needs a positive number' "$($PET --interval abc $NO 2>&1)"
check "bad hook action" 'unknown hook action' "$($PET hook bogusaction $NO 2>&1)"
check "bad demo stage" 'unknown stage' "$($PET demo --stage nope $NO 2>&1)"
check "bad demo stage suggests real ones" 'egg, blip' "$($PET demo --stage nope $NO 2>&1)"
check "bad demo mood" 'unknown mood' "$($PET demo --mood nope $NO 2>&1)"
check_exit "bad input exits non-zero" 1 $PET bogus $NO

section "2. no stack traces escape"
for bad_cmd in "bogus" "--frobnicate" "hook bogusaction" "demo --stage nope"; do
  out=$($PET $bad_cmd $NO 2>&1)
  check_missing "no stack trace from: pet $bad_cmd" 'at Object.<anonymous>' "$out"
  check_missing "no 'unexpected error' from: pet $bad_cmd" 'unexpected error' "$out"
done

section "3. an unwritable state directory is explained, not thrown"
RO="$(mktemp -d)/ro"; mkdir -p "$RO"; chmod 500 "$RO"
out=$(REPOTCHI_HOME="$RO/state" $PET render $NO 2>&1)
check "permission problem is named" 'no permission to write' "$out"
check "and a fix is offered" 'REPOTCHI_HOME' "$out"
check_missing "no raw node error" 'EACCES: permission denied' "$out"

section "4. REPOTCHI_HOME pointing at a file"
FILEHOME="$(mktemp -d)/afile"; touch "$FILEHOME"
out=$(REPOTCHI_HOME="$FILEHOME" $PET render $NO 2>&1)
check "explains it is a file" 'is a file, not a directory' "$out"

section "5. a corrupt state file is quarantined, not fatal"
mkdir -p "$SANDBOX/state"; printf 'this is not json {{{' > "$SANDBOX/state/state.json"
out=$($PET status $NO 2>&1)
check "still reports a pet" 'Repotchi' "$out"
check_num "damaged copy kept for inspection" ge 1 "$(ls "$SANDBOX/state" | grep -c corrupt)"

section "6. doctor reports a healthy setup"
rm -rf "$SANDBOX/state"
git init -q --initial-branch=main "$SANDBOX/healthy"
git -C "$SANDBOX/healthy" config user.email dev@example.com
git -C "$SANDBOX/healthy" config user.name Dev
git -C "$SANDBOX/healthy" commit -q --allow-empty -m "chore: init"
$PET track "$SANDBOX/healthy" $NO >/dev/null
out=$($PET doctor $NO 2>&1)
check "checks node" 'node' "$out"
check "checks git" 'git' "$out"
check "checks state" 'state' "$out"
check "checks the terminal" 'terminal' "$out"
check "declares health" 'everything looks healthy' "$out"
check_exit "healthy doctor exits 0" 0 $PET doctor $NO

section "7. doctor catches the silent email mismatch"
git init -q --initial-branch=main "$SANDBOX/mismatch"
git -C "$SANDBOX/mismatch" config user.email me@local.example
git -C "$SANDBOX/mismatch" config user.name Me
GIT_AUTHOR_EMAIL=me@gitlab.example git -C "$SANDBOX/mismatch" commit -q --allow-empty -m "feat: from gitlab"
$PET track "$SANDBOX/mismatch" $NO >/dev/null
out=$($PET doctor $NO 2>&1)
check "names the configured address" 'me@local.example' "$out"
check "names the actual author" 'me@gitlab.example' "$out"
check "says nothing here will feed it" 'will ever feed the pet' "$out"
check_exit "a failing doctor exits 1" 1 $PET doctor $NO

section "8. doctor notices a repo that has gone missing"
rm -rf "$SANDBOX/healthy"
out=$($PET doctor $NO 2>&1)
check "flags the dead repo" 'not a git repository any more' "$out"
check "offers the untrack command" 'pet untrack' "$out"
out=$($PET repos $NO 2>&1)
check "repos listing flags it too" 'missing' "$out"
check_missing "and scanning still does not crash" 'unexpected error' "$($PET scan $NO 2>&1)"

section "9. destructive commands ask first"
out=$($PET reset $NO 2>&1)
check "reset refuses without --yes" 're-run with' "$out"
check_exit "and exits non-zero" 1 $PET reset $NO
check "reset --yes goes through" 'a new egg appears' "$($PET reset --yes $NO 2>&1)"

section "10. no repositories tracked is stated plainly"
check "scan says so" 'no repositories tracked' "$($PET scan $NO 2>&1)"
check "repos says so" 'no repos tracked' "$($PET repos $NO 2>&1)"

section "11. help and version"
check "version is bare" "$(node -e "console.log(require('$ROOT/package.json').version)")" "$($PET --version 2>&1)"
check "help shows getting started" 'getting started' "$($PET --help $NO 2>&1)"
check "help mentions doctor" 'pet doctor' "$($PET --help $NO 2>&1)"
check "help explains server-side MRs do not count" 'Nothing server-side counts' "$($PET --help $NO 2>&1)"

section "11b. settings: the frame colour"
out=$($PET config $NO 2>&1)
check "config lists the frame setting" 'frame' "$out"
check "with all its options" 'mood, red, green, yellow, blue, magenta, cyan, white, gray, pink, sky' "$out"
check "setting a colour is confirmed" 'frame = blue' "$($PET config frame blue $NO 2>&1)"
check "and read back" 'blue' "$($PET config frame $NO 2>&1)"
check "unknown colour is refused" 'cannot be "purple"' "$($PET config frame purple $NO 2>&1)"
check "unknown setting is refused" 'unknown setting' "$($PET config nosuch $NO 2>&1)"
check "--frame validates too" 'unknown frame colour' "$($PET render --frame bogus $NO 2>&1)"
check_num "ten colours plus mood" eq 11 "$(node -e "console.log(require('$ROOT/src/render').FRAME_CHOICES.length)")"
$PET config frame mood $NO >/dev/null
check "back to mood" 'mood' "$($PET config frame $NO 2>&1)"

section "12. every command survives every hostile environment"
# The matrix that matters: no command may emit a stack trace or an
# "unexpected error", whatever state the machine is in.
ONLYNODE="$(mktemp -d)"; ln -sf "$(command -v node)" "$ONLYNODE/node"
CORRUPT="$(mktemp -d)/state"; mkdir -p "$CORRUPT"; printf '{{{ broken' > "$CORRUPT/state.json"
READONLY="$(mktemp -d)/ro"; mkdir -p "$READONLY"; chmod 500 "$READONLY"
GONE="$(mktemp -d)"
git init -q --initial-branch=main "$GONE/repo"
git -C "$GONE/repo" config user.email a@b.c && git -C "$GONE/repo" config user.name A
git -C "$GONE/repo" commit -q --allow-empty -m init
DEAD="$(mktemp -d)/state"
REPOTCHI_HOME="$DEAD" $PET track "$GONE/repo" $NO >/dev/null 2>&1
rm -rf "$GONE/repo"

crashy() {
  # Anything that looks like an unhandled throw rather than a handled failure.
  grep -qE 'at Object\.<anonymous>|at Module\._compile|unexpected error|Node\.js v[0-9]' <<< "$1"
}

for cmd in "render --width 60" "status" "doctor" "repos" "scan" "feed" "demo --stage blip" "help" "--version" "untrack /tmp" "config" "config frame"; do
  for envname in "clean" "nogit" "corrupt" "readonly" "deadrepo"; do
    case "$envname" in
      clean)    out=$(REPOTCHI_HOME="$SANDBOX/state" $PET $cmd $NO 2>&1) ;;
      nogit)    out=$(env PATH="$ONLYNODE" REPOTCHI_HOME="$SANDBOX/state" node "$ROOT/bin/pet" $cmd $NO 2>&1) ;;
      corrupt)  out=$(REPOTCHI_HOME="$CORRUPT" $PET $cmd $NO 2>&1) ;;
      readonly) out=$(REPOTCHI_HOME="$READONLY/state" $PET $cmd $NO 2>&1) ;;
      deadrepo) out=$(REPOTCHI_HOME="$DEAD" $PET $cmd $NO 2>&1) ;;
    esac
    if crashy "$out"; then
      bad "pet $cmd [$envname] crashed"
      printf '       %s\n' "$(head -3 <<< "$out")"
    else
      ok "pet $cmd [$envname]"
    fi
  done
done

section "13. missing git is named as missing git"
out=$(env PATH="$ONLYNODE" REPOTCHI_HOME="$SANDBOX/state" node "$ROOT/bin/pet" track /tmp $NO 2>&1)
check "track says git is missing" 'git is' "$out"
check_missing "and does not blame the directory" 'not a git repository' "$out"
out=$(env PATH="$ONLYNODE" REPOTCHI_HOME="$SANDBOX/state" node "$ROOT/bin/pet" doctor $NO 2>&1)
check "doctor reports it too" 'not installed' "$out"

section "14. paths are built portably"
# Windows separators differ, so filesystem paths must go through path.join or
# path.resolve rather than being glued together with slashes.
glued=$(rg -c "\+\s*'/'|'/'\s*\+|\+\s*\"/\"|\"/\"\s*\+" "$ROOT/src" 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
check_num "no hand-concatenated path separators" eq 0 "$glued"
joins=$(rg -c "path\.(join|resolve|dirname|basename)" "$ROOT/src" 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
check_num "paths go through the path module" gt 5 "$joins"
check_missing "no hardcoded home directory" '/home/' "$(cat "$ROOT"/src/*.js)"

section "15. piping into head is not a crash"
$PET demo $NO 2>/dev/null | head -1 >/dev/null
check_num "no EPIPE stack on stdout" eq 0 "$($PET demo $NO 2>&1 >/dev/null | grep -c EPIPE)"

finish
