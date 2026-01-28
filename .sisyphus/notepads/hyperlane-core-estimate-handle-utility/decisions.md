## [2026-01-28T11:32:00Z] Task 3: ICA Integration Decision

**Decision**: SKIP ICA integration

**Rationale**:

1. **No HyperlaneCore access**: ICA extends `RouterApp`, not `HyperlaneCore`
2. **Different context**: ICA has its own `multiProvider` but no HyperlaneCore instance
3. **Adding dependency adds complexity**: Would need to pass HyperlaneCore to ICA constructor or create one
4. **Current code works**: ICA's `estimateIcaHandleGas()` is functional and tested
5. **Utility exists for future use**: The new `estimateHandleGas()` utility is available if needed later

**ICA-specific considerations**:

- ICA calls `router.estimateGas.handle()` where router = InterchainAccountRouter
- ICA encodes ICA-specific message body (owner, ISM, calls)
- ICA adds gas buffer via `addBufferToGasLimit()` (HyperlaneCore doesn't)
- ICA has fallback logic for individual call estimation

**Conclusion**: The utility achieves its goal (code reuse for HyperlaneCore), but forcing ICA integration would add unnecessary complexity without clear benefit.
