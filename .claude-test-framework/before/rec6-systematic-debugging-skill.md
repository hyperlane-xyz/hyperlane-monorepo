# BEFORE: Recommendation #6 - Systematic Debugging Skill

## Test Setup

- **Test Prompt:** "Debug why messages are stuck in the relayer queue for arbitrum"
- **Date:** 2026-01-16

## Current Configuration

We have operational debugging in operations.md but no systematic debugging methodology skill. When debugging:

- Approach varies by session
- May jump to solutions without understanding root cause
- No consistent reproduction steps
- Documentation of findings inconsistent

## Observed Behavior

When asked to debug:

1. Claude may jump directly to potential fixes
2. No systematic isolation of root cause
3. Fix verification may be skipped
4. Similar issues may not be checked

### Response Quality

- **Score: 3/5** - Often finds fixes but process inconsistent

### Problems Identified

1. No standardized debugging workflow
2. Root cause analysis may be shallow
3. Fix verification not systematic
4. Documentation template not used
