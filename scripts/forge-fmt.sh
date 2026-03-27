#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
check=false

if [[ "${1-}" == "--check" ]]; then
  check=true
  shift
fi

collect_changed_files() {
  git -C "$repo_root" diff --name-only --diff-filter=d -- '*.sol'
  git -C "$repo_root" diff --cached --name-only --diff-filter=d -- '*.sol'
  git -C "$repo_root" ls-files --others --exclude-standard -- '*.sol'
}

normalize_path() {
  local path="$1"

  path="${path#./}"

  if [[ "$path" == "$repo_root/"* ]]; then
    path="${path#$repo_root/}"
  fi

  printf '%s\n' "$path"
}

route_file() {
  local path="$1"

  [[ -z "$path" || "$path" != *.sol ]] && return 0

  case "$path" in
    solidity/multicollateral/*)
      multicollateral_files+=("${path#solidity/multicollateral/}")
      ;;
    solidity/*)
      solidity_files+=("${path#solidity/}")
      ;;
    typescript/helloworld/*)
      helloworld_files+=("${path#typescript/helloworld/}")
      ;;
    *)
      printf 'Unsupported Solidity path: %s\n' "$path" >&2
      exit 1
      ;;
  esac
}

run_forge_fmt() {
  local project_dir="$1"
  shift

  [[ "$#" -eq 0 ]] && return 0

  local args=(fmt)
  if [[ "$check" == true ]]; then
    args+=(--check)
  fi

  (
    cd "$repo_root/$project_dir"
    forge "${args[@]}" "$@"
  )
}

solidity_files=()
multicollateral_files=()
helloworld_files=()

if [[ "$#" -eq 0 ]]; then
  while IFS= read -r path; do
    route_file "$path"
  done < <(collect_changed_files | sed '/^$/d' | sort -u)
else
  for path in "$@"; do
    route_file "$(normalize_path "$path")"
  done
fi

run_forge_fmt "solidity" "${solidity_files[@]}"
run_forge_fmt "solidity/multicollateral" "${multicollateral_files[@]}"
run_forge_fmt "typescript/helloworld" "${helloworld_files[@]}"
