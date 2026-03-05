---
name: claude-tob-review
description: Trail of Bits security skills analysis for Solidity contracts. Use for deep smart contract security review with invariant suggestions.
---

# Trail of Bits Security Review Skill

Use this skill for deep Solidity smart contract security analysis using Trail of Bits methodologies.

## When to Use

- Reviewing new or modified Solidity contracts
- Before deploying contract upgrades
- Security audit preparation
- Finding vulnerability variants

## Instructions

Read and apply the ToB security guidelines from `.github/prompts/tob-security-skills.md` to analyze the Solidity changes.

Provide findings with severity ratings and invariant recommendations for testing.

### For PR Reviews

When reviewing a PR, deliver feedback as a **single consolidated GitHub review** using `/inline-pr-comments`. Each run produces a separate review. The skill fetches prior reviews/comments for context — avoid duplicating previously raised issues.
