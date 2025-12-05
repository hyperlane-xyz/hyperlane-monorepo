# MultiSend to Submitter Migration Analysis

## Overview

This document analyzes the effort required to replace the current `MultiSend` infrastructure (`SafeMultiSend`, `SignerMultiSend`, `ManualMultiSend`) with the EV5/Safe/ICA submitter system (`EV5GnosisSafeTxSubmitter`, `EV5JsonRpcTxSubmitter`, `EvmIcaTxSubmitter`, etc.).

## Current Architecture

### MultiSend Classes (`typescript/infra/src/govern/multisend.ts`)

1. **SafeMultiSend**
   - Uses Safe SDK directly (`@safe-global/protocol-kit`, `@safe-global/api-kit`)
   - Handles multi-send vs individual transaction logic
   - Proposes transactions via Safe API
   - **Recently enhanced**: Now generates JSON fallback using `EV5GnosisSafeTxBuilder`

2. **SignerMultiSend**
   - Direct RPC submission via `multiProvider.sendTransaction()`
   - Estimates gas and sends transactions sequentially
   - Returns transaction receipts

3. **ManualMultiSend**
   - Just prints JSON for manual submission
   - No actual submission logic

### Usage in HyperlaneAppGovernor

- `sendCalls()` method orchestrates submission by `SubmissionType`:
  - `SubmissionType.SIGNER` → `SignerMultiSend`
  - `SubmissionType.SAFE` → `SafeMultiSend` (per governance type)
  - `SubmissionType.MANUAL` → `ManualMultiSend`
- Batches transactions (max 120 per batch)
- Handles confirmation prompts
- Filters by governance type for Safe submissions

## Target Architecture (Submitter System)

### Available Submitters (`typescript/sdk/src/providers/transactions/submitter/`)

1. **EV5GnosisSafeTxSubmitter**
   - Submits to Safe via API
   - Handles multi-send automatically (creates single Safe transaction with multiple calls)
   - Requires signer authorization check
   - Returns `void` (no receipts)

2. **EV5GnosisSafeTxBuilder**
   - Generates JSON for manual upload
   - No API calls (pure JSON generation)
   - Returns `GnosisTransactionBuilderPayload`

3. **EV5JsonRpcTxSubmitter**
   - Direct RPC submission
   - Returns `TransactionReceipt[]`
   - Sequential submission (similar to `SignerMultiSend`)

4. **EvmIcaTxSubmitter**
   - Submits via Interchain Accounts
   - Can wrap other submitters (e.g., Safe submitter for ICA)
   - Handles remote execution

5. **EV5TimelockSubmitter**
   - For timelock controller submissions
   - Not currently used in governor

6. **File Submitter** (to be created/adapted)
   - Writes transactions to a file (JSON/YAML format)
   - Similar to `ManualMultiSend` but persists to file instead of console
   - Currently exists in CLI package as `EV5FileSubmitter`
   - Needs to be created in SDK/infra or adapted from CLI version

### Submission Strategy System

- Uses `SubmissionStrategy` config per chain
- `getSubmitter()` factory creates appropriate submitter
- `TxSubmitterBuilder` provides fluent API for switching submitters

## Migration Effort Analysis

### 🔴 High Effort Items

#### 1. **Refactor `HyperlaneAppGovernor.sendCalls()`** (Est: 2-3 days)

**Current Flow:**
```typescript
sendCalls() {
  // Filter by SubmissionType
  // Create MultiSend instance
  // Batch (120 max)
  // Call multiSend.sendTransactions()
}
```

**Required Changes:**
- Replace `MultiSend` abstraction with `TxSubmitterInterface`
- Map `SubmissionType` → `TxSubmitterType`:
  - `SIGNER` → `JSON_RPC` (`EV5JsonRpcTxSubmitter`)
  - `SAFE` → `GNOSIS_SAFE` (`EV5GnosisSafeTxSubmitter`) with fallback to `GNOSIS_TX_BUILDER` (`EV5GnosisSafeTxBuilder`)
  - `MANUAL` → File submitter (writes transactions to file)
- Handle different return types (`void` vs `TransactionReceipt[]` vs file path)
- Implement fallback logic: `EV5GnosisSafeTxSubmitter` → `EV5GnosisSafeTxBuilder` on failure
- Maintain batching logic (submitters handle this differently)

**Complexity:**
- Submitters have different interfaces:
  - `EV5GnosisSafeTxSubmitter.submit()` returns `void`
  - `EV5JsonRpcTxSubmitter.submit()` returns `TransactionReceipt[]`
  - `EV5GnosisSafeTxBuilder.submit()` returns JSON payload
  - File submitter returns `[]` (writes to file)
- Need to handle these differences in error handling and logging
- **File submitter**: Currently only exists in CLI package (`EV5FileSubmitter`), may need to create one in SDK/infra or adapt CLI version

#### 2. **Submission Strategy Configuration** (Est: 1-2 days)

**Current:**
- Hardcoded in `HyperlaneAppGovernor.sendCalls()`
- Safe addresses come from `getGovernanceSafes(governanceType)`
- Signer comes from `multiProvider.getSigner(chain)`

**Required:**
- Build `SubmissionStrategy` config dynamically based on:
  - Governance type (for Safe addresses)
  - Chain metadata
  - Signer availability
- Or create a mapping function: `(chain, governanceType, signer) => SubmissionStrategy`

**Considerations:**
- Submitters require more configuration upfront (Safe address, chain, etc.)
- Need to handle cases where submitter creation fails (e.g., no Safe API URL)

#### 3. **Error Handling & Fallback Logic** (Est: 1 day)

**Current:**
- `SafeMultiSend` now has JSON fallback (recently added)
- Errors are caught and logged, but process continues

**Required:**
- Implement fallback chain: `EV5GnosisSafeTxSubmitter` → `EV5GnosisSafeTxBuilder` on failure
  - Try `EV5GnosisSafeTxSubmitter.submit()` first
  - On failure (API error, authorization failure, etc.), fall back to `EV5GnosisSafeTxBuilder.submit()` to generate JSON
- Handle submitter creation failures gracefully
- Maintain current error logging and user feedback

**Complexity:**
- Submitters throw different error types
- Need consistent error handling across submitter types
- JSON fallback should work seamlessly
- Must catch errors from `EV5GnosisSafeTxSubmitter` and retry with `EV5GnosisSafeTxBuilder`

#### 4. **ICA Integration** (Est: 1-2 days)

**Current:**
- ICA calls are inferred in `inferICAEncodedSubmissionType()`
- Encoded calls are submitted via Safe on origin chain

**Required:**
- Use `EvmIcaTxSubmitter` for ICA calls
- Configure internal submitter (likely Safe submitter)
- Ensure ICA routing works correctly

**Complexity:**
- ICA submitter wraps another submitter
- Need to ensure owner address matches Safe address (validation exists)
- Testing required for end-to-end ICA flow

### 🟡 Medium Effort Items

#### 5. **Transaction Format Conversion** (Est: 0.5 days)

**Current:**
- `AnnotatedCallData` → `CallData` (to, data, value)

**Required:**
- `AnnotatedCallData` → `AnnotatedEV5Transaction` (adds `chainId`)
- Already done in recent `SafeMultiSend` changes
- Need to apply consistently across all submission paths

#### 6. **Batching Logic** (Est: 0.5 days)

**Current:**
- Batches up to 120 transactions
- `SafeMultiSend` handles multi-send automatically

**Required:**
- `EV5GnosisSafeTxSubmitter` handles batching internally (creates single Safe tx)
- `EV5JsonRpcTxSubmitter` submits sequentially (no batching)
- May need to adjust batch sizes or remove batching for Safe submitters

#### 7. **Testing & Validation** (Est: 2-3 days)

**Required:**
- Unit tests for new submission flow
- Integration tests with actual Safe/ICA submitters
- Test error scenarios and fallbacks
- Validate JSON fallback works correctly
- Test with different governance types

### 🟢 Low Effort Items

#### 8. **Remove MultiSend Classes** (Est: 0.5 days)

- Delete `multisend.ts` file
- Remove imports from `HyperlaneAppGovernor`
- Clean up any remaining references

#### 9. **File Submitter Implementation** (Est: 1 day)

**Required:**
- Create file submitter in SDK/infra (or adapt `EV5FileSubmitter` from CLI)
- File submitter should write transactions to a file (JSON/YAML format)
- Similar to `ManualMultiSend` but writes to file instead of console
- Must implement `TxSubmitterInterface<ProtocolType.Ethereum>`

**Options:**
- Option A: Create `EV5FileSubmitter` in SDK (reusable across packages)
- Option B: Create `InfraFileSubmitter` in infra package (infra-specific)
- Option C: Adapt CLI's `EV5FileSubmitter` for use in infra

#### 10. **Update Type Definitions** (Est: 0.5 days)

- Update `SubmissionType` enum if needed
- Ensure type compatibility between `AnnotatedCallData` and `AnnotatedEV5Transaction`
- Add file submitter type to `TxSubmitterType` enum if creating new submitter

## Key Differences & Considerations

### 1. **Multi-Send Handling**

**Current (`SafeMultiSend`):**
- Checks if MultiSend contract exists
- Falls back to individual transactions if not available
- Handles this logic internally

**Submitters (`EV5GnosisSafeTxSubmitter`):**
- Always creates single Safe transaction with multiple calls
- Uses `onlyCalls: true` for multi-send
- No explicit MultiSend contract check

**Impact:** May need to verify behavior matches current logic

### 2. **Transaction Receipts**

**Current:**
- `SignerMultiSend` returns receipts
- `SafeMultiSend` returns `void` (proposes, doesn't execute)
- `ManualMultiSend` returns `void`

**Submitters:**
- `EV5JsonRpcTxSubmitter` returns `TransactionReceipt[]`
- `EV5GnosisSafeTxSubmitter` returns `void`
- `EV5GnosisSafeTxBuilder` returns JSON payload (for manual upload)
- File submitter returns `[]` (writes transactions to file)

**Impact:** Need to handle different return types in `sendCalls()`

### 3. **Authorization Checks**

**Current (`SafeMultiSend`):**
- No explicit authorization check
- Relies on Safe API to reject unauthorized proposals

**Submitters (`EV5GnosisSafeTxSubmitter`):**
- `canProposeSafeTransactions()` check in `create()`
- Fails fast if signer not authorized

**Impact:** May need to handle authorization failures differently

### 4. **Error Handling**

**Current:**
- Errors caught and logged
- Process continues to next batch/chain
- JSON fallback on Safe API failure (recent addition)

**Submitters:**
- Submitters throw errors
- Need to catch and handle appropriately
- JSON fallback should be implemented at governor level

## Migration Strategy

### Phase 1: Parallel Implementation (Low Risk)
1. Keep `MultiSend` classes
2. Add submitter-based path alongside existing code
3. Feature flag to switch between implementations
4. Test submitter path thoroughly

### Phase 2: Gradual Migration (Medium Risk)
1. Migrate `SIGNER` → `EV5JsonRpcTxSubmitter` first (simplest)
2. Migrate `MANUAL` → File submitter (create or adapt `EV5FileSubmitter` from CLI)
3. Migrate `SAFE` → `EV5GnosisSafeTxSubmitter` with fallback to `EV5GnosisSafeTxBuilder` last (most complex)

### Phase 3: Complete Migration (Higher Risk)
1. Remove `MultiSend` classes
2. Remove feature flag
3. Clean up old code

## Estimated Total Effort

| Category | Effort | Risk |
|----------|--------|------|
| Core refactoring | 2-3 days | Medium |
| Strategy configuration | 1-2 days | Low |
| Error handling | 1 day | Medium |
| ICA integration | 1-2 days | Medium |
| Transaction conversion | 0.5 days | Low |
| Batching logic | 0.5 days | Low |
| File submitter implementation | 1 day | Low |
| Testing | 2-3 days | Low |
| Cleanup | 0.5 days | Low |
| **Total** | **10-14 days** | **Medium** |

## Benefits of Migration

1. **Unified Interface**: Single abstraction for all submission types
2. **Better Testability**: Submitters are more modular and testable
3. **ICA Support**: Native ICA submitter support
4. **Consistency**: Same submission system used across SDK and infra
5. **Future-Proof**: Easier to add new submitter types (e.g., timelock)
6. **Configuration**: Strategy-based configuration is more flexible

## Risks & Mitigation

1. **Breaking Changes**: Test thoroughly before removing old code
2. **Behavior Differences**: Verify multi-send behavior matches
3. **Error Handling**: Ensure fallbacks work correctly
4. **Performance**: Monitor batch sizes and submission times

## Recommendation

**Proceed with migration**, but use phased approach:
1. Start with parallel implementation (Phase 1)
2. Migrate incrementally (Phase 2)
3. Complete migration after validation (Phase 3)

The effort is moderate (~2 weeks) and the benefits outweigh the risks, especially given that:
- JSON fallback is already partially integrated
- Submitter system is well-tested in SDK
- Migration path is clear
