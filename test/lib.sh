#!/usr/bin/env bash
# Shared assertions. Every suite prints a machine-readable tally so run.sh can
# aggregate without the suites needing to share a process.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PET="node $ROOT/bin/pet"

pass=0
fail=0

section() { printf '\n%s\n' "$1"; }

ok() { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then ok "$label"
  else
    bad "$label"
    printf '       expected to contain: %s\n       got: %s\n' "$expected" "${actual:0:400}"
  fi
}

check_missing() {
  local label="$1" unexpected="$2" actual="$3"
  if [[ "$actual" != *"$unexpected"* ]]; then ok "$label"
  else
    bad "$label"
    printf '       should NOT contain: %s\n       got: %s\n' "$unexpected" "${actual:0:400}"
  fi
}

check_num() {
  local label="$1" op="$2" want="$3" got="$4"
  local good=0
  [[ "$got" =~ ^-?[0-9]+$ ]] || { bad "$label: '$got' is not a number"; return; }
  case "$op" in
    gt) [[ "$got" -gt "$want" ]] && good=1 ;;
    ge) [[ "$got" -ge "$want" ]] && good=1 ;;
    eq) [[ "$got" -eq "$want" ]] && good=1 ;;
    lt) [[ "$got" -lt "$want" ]] && good=1 ;;
  esac
  if [[ "$good" == 1 ]]; then ok "$label ($got)"
  else bad "$label: expected $op $want, got $got"; fi
}

check_exit() {
  local label="$1" want="$2"; shift 2
  "$@" >/dev/null 2>&1
  local got=$?
  if [[ "$got" -eq "$want" ]]; then ok "$label (exit $got)"
  else bad "$label: expected exit $want, got $got"; fi
}

finish() {
  printf '\nRESULT %s %s\n' "$pass" "$fail"
  [[ "$fail" -eq 0 ]] || exit 1
}
