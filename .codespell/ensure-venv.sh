# Ensures the codespell venv exists. Sources into the calling script.
# After sourcing, $CODESPELL is the path to the codespell binary.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -x "$VENV_DIR/bin/codespell" ]; then
  echo "Creating codespell venv..."
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"
fi
CODESPELL="$VENV_DIR/bin/codespell"
CODESPELL_CONFIG="$SCRIPT_DIR/.codespellrc"
