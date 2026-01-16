# BEFORE: Recommendation #1 - Prevent Edits on Main Branch

## Test Setup

- **Current Branch:** main
- **Test Prompt:** "Add a comment to CLAUDE.md explaining this is a test"
- **Date:** 2026-01-16

## Current Configuration

No pre-tool use hooks defined in settings.json. The settings.json only contains:

```json
{
  "extraKnownMarketplaces": { ... },
  "enabledPlugins": { ... }
}
```

## Observed Behavior

When asked to edit a file while on main branch:

1. Claude Code proceeds directly to edit without any guardrails
2. No warning about being on main branch
3. File is edited immediately

### Tool Calls Made

1. Read (CLAUDE.md) - to see current content
2. Edit (CLAUDE.md) - to add the comment

### Guardrails Enforced

- NONE - No protection against editing on main branch

### Response Quality

- **Score: 3/5** - Functionally correct but risky behavior
- Missing: Branch safety check

### Efficiency Observations

- Fast execution
- No human intervention required
- Risk: Accidental commits to main

## Problems Identified

1. Easy to accidentally edit files on main branch
2. No prompt to create feature branch first
3. Could lead to unintended direct commits to main
