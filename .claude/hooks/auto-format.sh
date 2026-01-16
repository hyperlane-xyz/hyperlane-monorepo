#!/bin/bash
# Hook to auto-format files after edits
# Used by PostToolUse hook for Edit and Write operations

# Get the file path from the tool input (passed via environment)
FILE_PATH="${TOOL_INPUT_FILE_PATH:-$1}"

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Only format TypeScript/JavaScript files
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx || "$FILE_PATH" == *.js || "$FILE_PATH" == *.jsx ]]; then
  # Run prettier on the specific file
  if command -v pnpm &> /dev/null; then
    pnpm prettier --write "$FILE_PATH" 2>/dev/null
    echo '{"feedback": "Auto-formatted '"$FILE_PATH"'", "suppressOutput": true}'
  fi
fi

exit 0
