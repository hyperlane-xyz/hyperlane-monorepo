# HyperlaneCore estimateHandle Utility Extraction

## TL;DR

> **Quick Summary**: Add flexible `estimateHandleGas()` method to HyperlaneCore accepting minimal params (origin, destination, recipient, sender, body) instead of requiring full DispatchedMessage. ICA can then use this utility.
>
> **Deliverables**:
>
> - New `estimateHandleGas()` method in HyperlaneCore
> - Refactored existing `estimateHandle()` to use new utility internally
> - Updated ICA to use HyperlaneCore utility (if beneficial)
> - Unit tests for new method
>
> **Estimated Effort**: Quick
> **Parallel Execution**: NO - sequential (small task)
> **Critical Path**: Task 1 → Task 2 → Task 3

---

## Context

### Original Request

From yorke's comments on PR #7842 regarding `InterchainAccount.estimateIcaHandleGas()`:

> "does hyperlane core have a utility for this?"
> "I see HyperlaneCore.estimateHandle but that requires a full message?"
> "we could omit everything other than origin, destination, sender, body"
> "lets try and make a quick PR to tidy this up"

### Interview Summary

**Key Analysis**:

- Both `HyperlaneCore.estimateHandle()` and `InterchainAccount.estimateIcaHandleGas()` estimate gas for `handle(origin, sender, body)` calls
- Both use same pattern: `contract.estimateGas.handle(origin, sender, body, { from: mailbox })`
- Both contracts implement `IMessageRecipient.handle(uint32 _origin, bytes32 _sender, bytes _message)` interface
- Difference: HyperlaneCore calls recipient contract, ICA calls router contract - but signature identical

**Current Code**:

`HyperlaneCore.estimateHandle()` (requires full message):

```typescript
async estimateHandle(message: DispatchedMessage): Promise<string> {
  try {
    return (await this.getRecipient(message).estimateGas.handle(
      message.parsed.origin,
      message.parsed.sender,
      message.parsed.body,
      { from: this.getAddresses(this.getDestination(message)).mailbox },
    )).toString();
  } catch (error) {
    return '0';
  }
}
```

`InterchainAccount.estimateIcaHandleGas()` (manual construction):

```typescript
const gasEstimate = await destinationRouter.estimateGas.handle(
  originDomain,
  addressToBytes32(localRouterAddress),
  messageBody,
  { from: await destinationRouter.mailbox() },
);
return addBufferToGasLimit(gasEstimate);
```

### Metis Review

**Key Insight Validated**: Both use same `handle(origin, sender, body)` interface - code IS reusable.

**Addressed Gaps**:

- Confirmed handle() signatures are identical across IMessageRecipient implementations
- Plan includes backward compatibility (existing method unchanged, calls new utility)
- Tests required for new utility

---

## Work Objectives

### Core Objective

Extract reusable gas estimation utility from HyperlaneCore that accepts minimal params, enabling ICA and future code to reuse it.

### Concrete Deliverables

1. New `estimateHandleGas()` method in `HyperlaneCore.ts`
2. Existing `estimateHandle(message)` refactored to use new method internally
3. Updated `InterchainAccount.estimateIcaHandleGas()` to optionally use new utility
4. Unit tests for new method

### Definition of Done

- [ ] `pnpm -C typescript/sdk build` passes
- [ ] `pnpm -C typescript/sdk test` passes
- [ ] New method exported and usable
- [ ] Existing behavior unchanged

### Must Have

- Minimal params: origin domain, destination chain, recipient address, sender bytes32, body
- Return string (matching existing `estimateHandle` return type)
- Error handling: return '0' on failure (matching existing behavior)
- Backward compatible: existing `estimateHandle(message)` signature unchanged

### Must NOT Have (Guardrails)

- NO gas buffer logic (ICA adds buffer separately)
- NO retry logic
- NO behavior changes to existing `estimateHandle()`
- NO breaking changes to public API
- NO new dependencies

---

## Verification Strategy (MANDATORY)

### Test Decision

- **Infrastructure exists**: YES (vitest)
- **User wants tests**: YES (new utility must have tests)
- **Framework**: vitest

### Testing Approach

- Add unit tests for new `estimateHandleGas()` method
- Verify existing `estimateHandle()` tests still pass
- Mock provider for gas estimation scenarios

---

## Execution Strategy

### Sequential Execution

Small task - execute sequentially:

1. Task 1: Add new `estimateHandleGas()` method
2. Task 2: Refactor existing `estimateHandle()` to use new method
3. Task 3: Consider ICA integration (may skip if complexity outweighs benefit)

### Dependency Matrix

| Task | Depends On | Blocks |
| ---- | ---------- | ------ |
| 1    | None       | 2, 3   |
| 2    | 1          | None   |
| 3    | 1          | None   |

---

## TODOs

- [x] 1. Add new `estimateHandleGas()` method to HyperlaneCore

  **What to do**:

  - Add new method signature accepting minimal params:
    ```typescript
    async estimateHandleGas(params: {
      destination: ChainName;
      recipient: Address;
      origin: number;
      sender: string;
      body: string;
    }): Promise<string>
    ```
  - Connect to recipient contract using `IMessageRecipient__factory`
  - Call `estimateGas.handle(origin, sender, body, { from: mailbox })`
  - Return string (gas estimate or '0' on failure)
  - Add JSDoc documenting purpose and when to use

  **Must NOT do**:

  - Add gas buffer (callers handle this)
  - Change return type from string
  - Add retry logic

  **Recommended Agent Profile**:

  - **Category**: `quick`
    - Reason: Single method addition, straightforward implementation
  - **Skills**: []
    - No special skills needed - standard TypeScript SDK work

  **Parallelization**:

  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Tasks 2, 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:

  - `typescript/sdk/src/core/HyperlaneCore.ts:256-276` - Existing `estimateHandle()` pattern to follow for error handling and logging
  - `typescript/sdk/src/core/HyperlaneCore.ts:249-254` - `getRecipient()` helper shows how to connect to recipient contract

  **API/Type References**:

  - `typescript/sdk/src/core/types.ts:94-98` - `DispatchedMessage` type to understand what fields are available
  - `@hyperlane-xyz/core` - `IMessageRecipient__factory` for connecting to handle() interface

  **Test References**:

  - `typescript/sdk/src/core/HyperlaneCore.test.ts` - Existing test patterns for HyperlaneCore

  **WHY Each Reference Matters**:

  - `estimateHandle()` shows exact error handling pattern (try/catch, return '0', debug logging)
  - `getRecipient()` shows provider access pattern via multiProvider
  - Tests show mocking patterns for gas estimation

  **Acceptance Criteria**:

  **Implementation Verification:**

  - [x] Method compiles: `pnpm -C typescript/sdk build` → SUCCESS
  - [x] Method is exported: Can import `HyperlaneCore` and call `estimateHandleGas()`
  - [x] Returns string type (BigNumber.toString())
  - [x] Returns '0' on estimation failure (matches existing behavior)

  **Test Verification:**

  - [x] Add test case: successful gas estimation returns numeric string
  - [x] Add test case: failed estimation returns '0'
  - [x] `pnpm -C typescript/sdk test` → PASS

  **Commit**: YES

  - Message: `feat(sdk): add estimateHandleGas utility to HyperlaneCore`
  - Files: `typescript/sdk/src/core/HyperlaneCore.ts`
  - Pre-commit: `pnpm -C typescript/sdk build && pnpm -C typescript/sdk test`

---

- [x] 2. Refactor existing `estimateHandle()` to use new utility

  **What to do**:

  - Modify `estimateHandle(message: DispatchedMessage)` to call `estimateHandleGas()` internally
  - Extract recipient address from message using existing `getRecipient()` pattern
  - Preserve exact same public API and behavior
  - Keep debug logging

  **Must NOT do**:

  - Change method signature
  - Change return type
  - Change error behavior
  - Remove debug logging

  **Recommended Agent Profile**:

  - **Category**: `quick`
    - Reason: Simple refactor, internal implementation change only
  - **Skills**: []

  **Parallelization**:

  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (after Task 1)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:

  - `typescript/sdk/src/core/HyperlaneCore.ts:256-276` - Existing method to refactor
  - `typescript/sdk/src/core/HyperlaneCore.ts:108-114` - `getDestination()`, `getOrigin()` helpers

  **WHY Each Reference Matters**:

  - Need to preserve exact behavior of existing method
  - Need helper methods to extract params from DispatchedMessage

  **Acceptance Criteria**:

  **Implementation Verification:**

  - [x] `estimateHandle(message)` still works: passes existing tests
  - [x] Internally calls `estimateHandleGas()`: verify in code review
  - [x] No public API change: same signature, same return type

  **Test Verification:**

  - [x] Existing `estimateHandle` tests still pass
  - [x] `pnpm -C typescript/sdk test` → PASS

  **Commit**: YES (amend or separate)

  - Message: `refactor(sdk): use estimateHandleGas in estimateHandle`
  - Files: `typescript/sdk/src/core/HyperlaneCore.ts`
  - Pre-commit: `pnpm -C typescript/sdk test`

---

- [x] 3. Evaluate ICA integration (optional - may skip)

  **What to do**:

  - Assess if ICA can benefit from using `HyperlaneCore.estimateHandleGas()`
  - ICA currently calls `destinationRouter.estimateGas.handle()` directly
  - Would need HyperlaneCore instance in ICA context

  **Decision Point**:

  - If ICA already has/can get HyperlaneCore instance: integrate
  - If adding HyperlaneCore dependency adds complexity: skip (current code works)
  - The utility exists for future use; ICA integration is nice-to-have

  **Must NOT do**:

  - Force integration if it adds unnecessary complexity
  - Break ICA's current working implementation

  **Recommended Agent Profile**:

  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:

  - **Can Run In Parallel**: YES (with Task 2, after Task 1)
  - **Parallel Group**: Wave 2 (with Task 2)
  - **Blocks**: None
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:

  - `typescript/sdk/src/middleware/account/InterchainAccount.ts:232-239` - Current estimation code
  - `typescript/sdk/src/middleware/account/InterchainAccount.ts:44-53` - Class constructor (check for HyperlaneCore access)

  **WHY Each Reference Matters**:

  - Need to understand if HyperlaneCore is available in ICA context
  - Current code works - only change if it simplifies

  **Acceptance Criteria**:

  **Decision Made:**

  - [x] Evaluate: Does ICA have access to HyperlaneCore?
  - [x] If YES and simple: Integrate, add test
  - [x] If NO or complex: Document decision, skip (current code works)

  **Commit**: Conditional

  - If integrated: `refactor(sdk): use HyperlaneCore.estimateHandleGas in ICA`
  - If skipped: No commit needed (document in PR description)

---

## Commit Strategy

| After Task  | Message                                                     | Files                | Verification |
| ----------- | ----------------------------------------------------------- | -------------------- | ------------ |
| 1           | `feat(sdk): add estimateHandleGas utility to HyperlaneCore` | HyperlaneCore.ts     | pnpm test    |
| 2           | `refactor(sdk): use estimateHandleGas in estimateHandle`    | HyperlaneCore.ts     | pnpm test    |
| 3 (if done) | `refactor(sdk): use HyperlaneCore.estimateHandleGas in ICA` | InterchainAccount.ts | pnpm test    |

---

## Success Criteria

### Verification Commands

```bash
pnpm -C typescript/sdk build  # Expected: SUCCESS
pnpm -C typescript/sdk test   # Expected: PASS
```

### Final Checklist

- [x] New `estimateHandleGas()` method exists and works
- [x] Existing `estimateHandle(message)` unchanged in behavior
- [x] Tests pass
- [x] No breaking changes
- [x] Changeset added if needed (minor bump for new public method)
