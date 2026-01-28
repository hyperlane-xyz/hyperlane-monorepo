## [2026-01-28T11:30:00Z] Task 1: Build Errors (Pre-existing)

**Issue**: `pnpm -C typescript/sdk build` fails with:

```
error TS2305: Module '"@hyperlane-xyz/utils"' has no exported member 'formatStandardHookMetadata'.
```

**Files affected**:

- src/middleware/account/InterchainAccount.ts
- src/middleware/account/InterchainAccount.test.ts
- src/providers/transactions/submitter/IcaTxSubmitter.ts

**Root cause**: `formatStandardHookMetadata` exists in `typescript/utils/src/messages.ts:109` but is not exported from utils package index.

**Impact on Task 1**: NONE - this is pre-existing on main branch, not caused by new `estimateHandleGas()` method.

**Resolution**: This needs to be fixed separately (export from utils/src/index.ts). Not blocking Task 1 completion.
