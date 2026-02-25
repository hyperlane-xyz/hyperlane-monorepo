#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/ensure-venv.sh"
"$CODESPELL" --config="$CODESPELL_CONFIG" "$@"
