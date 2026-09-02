#!/usr/bin/env bash
# Runs every suite and aggregates the tallies. Exit code is the gate CI uses.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES=(git cli render)
[[ $# -gt 0 ]] && SUITES=("$@")

total_pass=0
total_fail=0
failed_suites=()

for suite in "${SUITES[@]}"; do
  file="$ROOT/test/$suite.sh"
  if [[ ! -f "$file" ]]; then
    printf '\n### %s: no such suite\n' "$suite"
    failed_suites+=("$suite")
    total_fail=$((total_fail + 1))
    continue
  fi

  printf '\n\033[1m### %s\033[0m\n' "$suite"
  output=$(bash "$file" 2>&1)
  status=$?
  # Echo everything except the machine-readable tally line.
  printf '%s\n' "$output" | grep -v '^RESULT '

  tally=$(printf '%s\n' "$output" | grep '^RESULT ' | tail -1)
  if [[ -n "$tally" ]]; then
    read -r _ p f <<< "$tally"
    total_pass=$((total_pass + p))
    total_fail=$((total_fail + f))
  fi
  [[ "$status" -eq 0 ]] || failed_suites+=("$suite")
done

printf '\n\033[1m### summary\033[0m\n'
printf '  %s passed, %s failed across %s suites\n' "$total_pass" "$total_fail" "${#SUITES[@]}"
if [[ ${#failed_suites[@]} -gt 0 ]]; then
  printf '  failing suites: %s\n' "${failed_suites[*]}"
  exit 1
fi
printf '  all green\n'
