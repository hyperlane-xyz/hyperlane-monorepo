---
name: solidity-review
description: Reviews Solidity code for security vulnerabilities, best practices, and code quality issues based on the Solcurity Standard. Use when the user asks to review, audit, or check Solidity contracts. (project)
allowed-tools: Read, Write, Grep, Glob, Bash(forge test:*), Bash(yarn --cwd solidity:*), Bash(slither:*), Bash(gh:*), Bash(git diff:*), Bash(git show:*)
---

# Solidity Code Review

## Overview

This skill reviews Solidity smart contracts for security vulnerabilities, best practices, and code quality issues. It follows the [Solcurity Standard](https://github.com/transmissions11/solcurity) and Hyperlane-specific patterns.

## Input Types

This skill accepts:

1. **File path(s)** - One or more `.sol` file paths to review
2. **GitHub PR URL** - A GitHub pull request URL (e.g., `https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/123`)
3. **PR number** - Just the PR number (e.g., `#123` or `123`)
4. **Local diff** - A git diff or branch comparison
5. **Contract name** - A contract name to find and review in the codebase

## GitHub PR Review Process

When given a GitHub PR URL or number:

### 1. Fetch PR Information

```bash
# Get PR metadata (title, description, author, base branch)
gh pr view <PR_NUMBER> --json title,body,author,baseRefName,headRefName,files

# Get the diff (Solidity files only)
gh pr diff <PR_NUMBER> -- '*.sol'

# List changed files
gh pr view <PR_NUMBER> --json files --jq '.files[].path' | grep '\.sol$'
```

### 2. Understand the Context

- Read the PR description for intent and scope
- Check which contracts are modified
- Identify if this is a new feature, bug fix, or refactor

### 3. Fetch Full File Context

For each modified `.sol` file, read the full file to understand:

- The complete contract structure
- Inheritance hierarchy
- Storage layout
- How the changed code fits into the whole

```bash
# View a specific file at the PR's head
gh pr diff <PR_NUMBER> --patch
```

### 4. Focus Review on Changes

- **Only flag issues in changed code** (lines with `+` in the diff)
- Understand surrounding context but don't review unchanged code
- Consider how changes interact with existing code

### 5. Check CI Status

```bash
# View check status
gh pr checks <PR_NUMBER>
```

## Review Checklist

### 1. Security Analysis (Critical)

#### Reentrancy (SWC-107)

- [ ] External calls follow checks-effects-interactions pattern
- [ ] State changes occur BEFORE external calls
- [ ] Reentrancy guards used where appropriate

#### Access Control

- [ ] Privileged functions have appropriate modifiers (`onlyOwner`, etc.)
- [ ] `msg.sender` validation is correct (don't assume it's the operated-upon user)
- [ ] Initialize functions are protected against re-initialization

#### Arithmetic (SWC-101)

- [ ] Unchecked blocks are safe and documented with gas savings reasoning
- [ ] Multiplication happens before division (unless overflow risk)
- [ ] Precision loss is documented with who benefits/suffers

#### External Calls (SWC-113, SWC-134)

- [ ] External call necessity verified
- [ ] DoS risk from errors assessed
- [ ] SafeERC20 used for token transfers OR return values checked
- [ ] `.call{value: ...}("")` used instead of `transfer`/`send`
- [ ] Contract existence checked before low-level calls

### 2. Storage & Variables (SWC-108, SWC-119)

- [ ] All variables have explicit visibility
- [ ] Storage variables are packed efficiently (adjacent smaller types)
- [ ] `constant` used for compile-time values
- [ ] `immutable` used for constructor-set values
- [ ] No state variable shadowing
- [ ] 256-bit types used unless packing for gas

### 3. Function Design

- [ ] `external` visibility when only called externally
- [ ] All parameters validated within safe bounds
- [ ] Return values always assigned
- [ ] Front-running vulnerabilities considered (SWC-114)
- [ ] Named arguments used for functions with many parameters

### 4. Signatures & Encoding (SWC-117, SWC-121, SWC-122, SWC-133)

- [ ] `abi.encode()` used over `abi.encodePacked()` for dynamic types
- [ ] Signatures protected with nonce and `block.chainid`
- [ ] EIP-712 implemented for signature standards

### 5. Events

- [ ] Events emitted for all storage mutations
- [ ] Action creator and operated-upon users/IDs are indexed
- [ ] Dynamic types (strings, bytes) are NOT indexed
- [ ] No function calls in event arguments

### 6. Code Quality

- [ ] Magic numbers replaced with named constants
- [ ] `delete` keyword used for zero-value assignments
- [ ] NatSpec comments on public/external functions
- [ ] Functions are focused and single-purpose
- [ ] Inheritance depth is reasonable (SWC-125)

### 7. DeFi-Specific (if applicable)

- [ ] AMM spot price NOT used as oracle
- [ ] Internal accounting separated from actual balances
- [ ] Rebasing token, fee-on-transfer, ERC-777 support documented
- [ ] Sanity checks against price manipulation
- [ ] No arbitrary calls from user input in approval targets

### 8. Upgrade Safety (if upgradeable)

- [ ] Storage layout preserved (no reordering, removal, or type changes)
- [ ] New storage variables added at the end
- [ ] Storage gaps maintained for future variables
- [ ] Initializer functions protected

## Review Process

1. **Read the contract(s)**: Understand the purpose and architecture
2. **Check imports and inheritance**: Review the dependency chain
3. **Analyze storage layout**: Look for packing opportunities and upgrade safety
4. **Review each function**:
   - Access control
   - Input validation
   - State changes
   - External calls
   - Return values
5. **Check events**: Verify all state changes emit appropriate events
6. **Run static analysis**: Use slither if available
7. **Run tests**: Verify tests pass with `forge test --match-contract <ContractName>`

## Output Format

Present findings in severity order and **write the review to a markdown file**.

### File Output

After completing the review, write the full report to `solidity/reviews/` (gitignored):

- **For PR reviews**: `solidity/reviews/REVIEW-PR-<PR_NUMBER>.md`
- **For file reviews**: `solidity/reviews/REVIEW-<CONTRACT_NAME>.md`
- **For branch comparisons**: `solidity/reviews/REVIEW-<BRANCH_NAME>.md`

The file should be self-contained and include:

1. PR/file metadata (title, author, files changed)
2. Executive summary with finding counts
3. Detailed findings organized by severity
4. Recommendations

### Report Structure

```markdown
## Review: <Contract Name or PR Title>

**Date:** YYYY-MM-DD
**Reviewer:** Claude (automated)
**PR/Files:** <link or file paths>

### Summary

| Severity      | Count |
| ------------- | ----- |
| Critical      | X     |
| High          | X     |
| Medium        | X     |
| Low           | X     |
| Informational | X     |
| Gas           | X     |

### Critical

- **[Issue Title]** (Line X): Description and recommendation

### High

- **[Issue Title]** (Line X): Description and recommendation

### Medium

- **[Issue Title]** (Line X): Description and recommendation

### Low

- **[Issue Title]** (Line X): Description and recommendation

### Informational

- **[Note Title]** (Line X): Observation or suggestion

### Gas Optimizations

- **[Optimization]** (Line X): Suggested improvement

### Recommendations

<Summary of key actions to take before merging>
```

## What NOT to Flag

- Minor style issues handled by prettier/linters
- Existing intentional patterns (check git history if unsure)
- Theoretical issues without practical exploit paths
- Code that wasn't changed (for PR reviews, focus on the diff)

## Hyperlane-Specific Patterns

### Key Contracts to Understand

- `Mailbox.sol` - Central hub for message dispatch/process
- `isms/` - Interchain Security Modules for verification
- `hooks/` - Post-dispatch hooks (gas payments, merkle tree)
- `token/` - Warp route implementations

### Common Patterns

- Domain IDs are NOT chain IDs
- Messages have sender, recipient, origin/destination domains, body
- ISMs provide pluggable verification logic
- Hooks handle post-dispatch processing

## Commands

### GitHub PR Commands

```bash
# View PR details
gh pr view <PR_NUMBER>

# Get PR diff (Solidity only)
gh pr diff <PR_NUMBER> -- '*.sol'

# Get PR metadata as JSON
gh pr view <PR_NUMBER> --json title,body,author,baseRefName,headRefName,files,reviews

# List changed Solidity files
gh pr view <PR_NUMBER> --json files --jq '.files[].path' | grep '\.sol$'

# Check CI status
gh pr checks <PR_NUMBER>

# Add a review comment
gh pr review <PR_NUMBER> --comment --body "Review comment here"
```

### Local Testing Commands

```bash
# Run all Solidity tests
yarn --cwd solidity test

# Run specific Forge tests
forge test --match-test <pattern> -vvv

# Run Slither static analysis
slither solidity/contracts/<path> --config-file solidity/slither.config.json

# Check gas snapshots
yarn --cwd solidity gas
```
