#!/bin/bash
# Hook to prevent edits on main branch
# Used by PreToolUse hook for Edit and Write operations

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)

if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  echo '{"block": true, "feedback": "Cannot edit files on main branch. Please create a feature branch first: git checkout -b <branch-name>"}'
  exit 2
fi

exit 0
