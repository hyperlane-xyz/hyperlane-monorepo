---
name: pr-review
description: Comprehensive pull request review workflow. Analyzes code changes, checks for security issues, validates patterns, and provides structured feedback.
---

# PR Review Command

Review the current branch's changes against main with comprehensive analysis.

## Workflow

1. **Gather Context**

   ```bash
   git diff main...HEAD --stat
   git log main..HEAD --oneline
   ```

2. **Analyze Changes**

   - Read each changed file
   - Check for security issues (OWASP top 10, smart contract vulnerabilities)
   - Validate against project patterns (TypeScript, Solidity, Rust rules)
   - Check test coverage for new code

3. **Generate Review**

   Provide structured feedback in three categories:

   ### Critical (Must Fix)

   - Security vulnerabilities
   - Breaking changes without migration
   - Missing access control
   - Incorrect business logic

   ### Warnings (Should Fix)

   - Missing tests for new functionality
   - Inconsistent patterns
   - Performance concerns
   - Documentation gaps

   ### Suggestions (Consider)

   - Code style improvements
   - Refactoring opportunities
   - Better naming

4. **Summary**
   - Overall assessment (Approve / Request Changes / Comment)
   - Key concerns
   - Recommended next steps

## Rules Integration

- Apply `.claude/rules/solidity.md` for Solidity changes
- Apply `.claude/rules/typescript.md` for TypeScript changes
- Apply `.claude/rules/rust.md` for Rust changes
- Use differential-review@trailofbits skill for security analysis

## Example Output

```
## PR Review: feature/add-batch-dispatch

### Files Changed: 5
- solidity/contracts/Mailbox.sol (+45, -2)
- solidity/test/Mailbox.t.sol (+120, -0)
- typescript/sdk/src/core/HyperlaneCore.ts (+30, -5)
...

### Critical Issues (1)
1. **Missing reentrancy guard** in `batchDispatch` (Mailbox.sol:156)
   - External calls made before state updates
   - Recommendation: Add `nonReentrant` modifier

### Warnings (2)
1. Missing tests for error cases in batch dispatch
2. SDK changes need changeset

### Suggestions (1)
1. Consider extracting dispatch logic to internal function

### Assessment: REQUEST CHANGES
Key blocker: Reentrancy vulnerability must be fixed before merge.
```
