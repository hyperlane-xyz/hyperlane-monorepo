# BEFORE: Recommendation #2 - Auto-Run Lint/Format After Edits

## Test Setup

- **Test Prompt:** "Add a new TypeScript function to typescript/utils/src/objects.ts"
- **Date:** 2026-01-16

## Current Configuration

No PostToolUse hooks defined. After editing a TypeScript file:

- No automatic formatting runs
- No automatic linting
- User must manually run `pnpm prettier` and `pnpm lint`

## Observed Behavior

When editing TypeScript files:

1. Claude Code makes the edit
2. No post-edit formatting check
3. Code may not match project formatting standards
4. Lint errors not caught until manual review

### Tool Calls Made

1. Read (typescript/utils/src/objects.ts)
2. Edit (typescript/utils/src/objects.ts)
3. (No automatic prettier/lint)

### Guardrails Enforced

- NONE - No automatic code quality checks

### Response Quality

- **Score: 3/5** - Functional but may leave inconsistent formatting

### Efficiency Observations

- Fast edit completion
- Risk: Formatting inconsistencies require manual correction
- Risk: Lint errors discovered later in workflow

## Problems Identified

1. No automatic formatting after edits
2. Manual `pnpm prettier` required
3. Possible CI failures due to formatting issues
4. Extra round-trips to fix formatting
