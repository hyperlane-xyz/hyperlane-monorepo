---
name: systematic-debugging
description: Four-phase debugging methodology for root cause analysis. Use when investigating bugs, test failures, or unexpected behavior.
---

# Systematic Debugging Methodology

## When to Use

- Investigating test failures
- Debugging unexpected behavior
- Analyzing production incidents
- Root cause analysis
- Any "why isn't this working?" situation

## Four-Phase Debugging Process

### Phase 1: REPRODUCE

Before fixing anything, reliably reproduce the issue.

**Steps:**

1. Get exact error message/behavior
2. Identify minimal reproduction steps
3. Document environment (branch, config, dependencies)
4. Confirm reproduction is consistent

**Example:**

```
Issue: "WarpCore.transfer fails on arbitrum"

Reproduction:
1. Branch: main @ commit abc123
2. Command: pnpm -C typescript/sdk test -- --grep "WarpCore"
3. Error: "TypeError: Cannot read property 'chainId' of undefined"
4. Consistent: Yes, fails 100% of the time
```

### Phase 2: ISOLATE

Narrow down the root cause location.

**Strategies:**

1. **Binary search** - Comment out half the code, see if error persists
2. **Trace backwards** - Start from error, trace data flow
3. **Minimal example** - Strip to smallest failing case
4. **Compare working vs broken** - What changed?

**Questions to ask:**

- What's the last known working state?
- What changed between working and broken?
- Is this environment-specific?
- Is this data-specific?

### Phase 3: IDENTIFY

Determine the exact root cause.

**Root Cause Categories:**
| Category | Examples |
|----------|----------|
| Data | Null/undefined, wrong type, missing field |
| State | Race condition, stale cache, incorrect initialization |
| Logic | Off-by-one, wrong operator, missing case |
| External | API change, network issue, config mismatch |
| Environment | Version mismatch, missing dependency |

**Verification:**

- Can you explain WHY the bug occurs?
- Can you predict when it will/won't occur?
- Do you understand the full impact?

### Phase 4: FIX

Implement and verify the fix.

**Fix Checklist:**

1. [ ] Write a test that fails without the fix
2. [ ] Implement minimal fix
3. [ ] Verify test passes
4. [ ] Check for similar issues elsewhere
5. [ ] Document if non-obvious

**Anti-patterns:**

- Don't fix symptoms, fix root cause
- Don't make multiple changes at once
- Don't skip the test

## Debugging Tools by Language

### TypeScript

```typescript
// Add strategic console.logs
console.log('DEBUG:', { variable, state, context });

// Use debugger statement
debugger; // Opens Chrome DevTools when running with --inspect

// Check types at runtime
console.log('Type:', typeof variable, variable?.constructor?.name);
```

### Solidity (Forge)

```solidity
// Use console.log in tests
import "forge-std/console.sol";
console.log("Value:", someValue);
console.logBytes32(messageId);

// Use vm.expectRevert for error testing
vm.expectRevert("Error message");
contract.failingFunction();

// Trace with -vvvv
// forge test -vvvv --match-test testName
```

### Rust

```rust
// Debug print
dbg!(&variable);

// Detailed logging
tracing::debug!(?variable, "Context message");

// Run single test with output
// cargo test test_name -- --nocapture
```

## Hyperlane-Specific Debugging

### Message Delivery Issues

1. Check message was dispatched (Mailbox events)
2. Verify ISM configuration on destination
3. Check validator signatures available
4. Verify relayer is processing the route

### SDK Issues

1. Check MultiProvider has chain configured
2. Verify contract addresses in registry
3. Check RPC connectivity
4. Validate chain metadata

### Agent Issues

1. Check agent logs in GCP
2. Verify config matches expected chains
3. Check for RPC errors
4. Use Grafana dashboards (see operations.md)

## Documentation Template

When debugging is complete, document:

```markdown
## Bug: [Brief description]

### Symptoms

- What was observed

### Root Cause

- Why it happened

### Fix

- What was changed

### Prevention

- How to avoid similar issues
```
