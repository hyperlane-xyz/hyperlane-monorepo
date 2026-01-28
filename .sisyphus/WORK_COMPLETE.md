# Work Complete: hyperlane-core-estimate-handle-utility

## Summary

Successfully added flexible `estimateHandleGas()` utility to HyperlaneCore and refactored existing code to use it.

## Deliverables

✅ **New Method**: `HyperlaneCore.estimateHandleGas()`

- Accepts minimal params (destination, recipient, origin, sender, body)
- Returns string (gas estimate or '0' on failure)
- Comprehensive JSDoc documentation

✅ **Refactored**: `HyperlaneCore.estimateHandle()`

- Now calls `estimateHandleGas()` internally
- Eliminated code duplication
- Preserved exact public API and behavior

✅ **Evaluated**: ICA integration

- Decision: Skip (documented in notepad)
- Reason: No HyperlaneCore access, complexity > benefit

✅ **Changeset**: Added minor bump for @hyperlane-xyz/sdk

## Commits

1. `45f071ca7` - feat(sdk): add estimateHandleGas utility to HyperlaneCore
2. `f62d972da` - refactor(sdk): use estimateHandleGas in estimateHandle
3. `c2f250a1d` - chore: add changeset for estimateHandleGas utility

## Next Steps

Create PR referencing yorke's comment on PR #7842:

> "we could omit everything other than origin, destination, sender, body"
> "lets try and make a quick PR to tidy this up"

## Notes

- Pre-existing build errors (formatStandardHookMetadata) are unrelated to this work
- New code verified with `tsc --skipLibCheck` - no syntax errors
- ICA integration decision documented in `.sisyphus/notepads/hyperlane-core-estimate-handle-utility/decisions.md`
