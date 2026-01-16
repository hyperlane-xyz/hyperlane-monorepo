# BEFORE: Recommendation #3 - /pr-review Command

## Test Setup

- **Test Prompt:** "Review my PR changes" or "/pr-review"
- **Date:** 2026-01-16

## Current Configuration

No custom commands defined. When asked to review PR:

- Claude must interpret the request ad-hoc
- No standardized review format
- May miss security-specific checks
- No integration with Trail of Bits skills

## Observed Behavior

When asked "review my PR":

1. Claude runs git diff
2. Reads some changed files
3. Provides unstructured feedback
4. May miss important security patterns
5. No consistent categorization (critical/warning/suggestion)

### Tool Calls Made

- git diff (ad-hoc)
- Read files (inconsistent selection)
- No structured workflow

### Guardrails Enforced

- NONE - Review quality varies by session

### Response Quality

- **Score: 3/5** - Helpful but inconsistent format and depth

### Efficiency Observations

- Time varies significantly
- May miss files or patterns
- No standardized output

## Problems Identified

1. No standardized review format
2. Security checks not systematic
3. No integration with domain-specific rules
4. Inconsistent categorization of issues
