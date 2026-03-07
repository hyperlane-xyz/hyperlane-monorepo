# Token-Based IGP Fees Rollout Plan

## Overview

Roll out ERC20 fee token support (USDC, USDT, oUSDT) for the Interchain Gas Paymaster across SDK, infra, and production deployments. The Solidity contracts are already merged from the `audit-q1-2026` branch (`#8196`). No contract changes are needed.

**Fee tokens:** USDC, USDT, oUSDT (ETH remains native — status quo)
**Margin:** 50% for all tokens (tunable later)
**Rollout:** Via `core apply` + Gnosis Safe strategy on warp route chains for the above tokens
**Testing:** Registry forks with Anvil
**Relayer:** No changes needed (backwards-compatible event indexing)

## Atomic Upgrade Strategy

After `ProxyAdmin.upgrade(proxy, newImpl)`, the new IGP implementation reads from `tokenGasOracles[NATIVE_TOKEN][domain]` — a new, empty mapping. The old data in `__deprecated_destinationGasConfigs` is unreachable. All dispatches through the IGP **revert** until the new storage is seeded.

**Solution:** Batch `ProxyAdmin.upgrade()` + `IGP.setDestinationGasConfigs()` + `IGP.setTokenGasOracles()` in a single Gnosis Safe multi-send transaction. All calls execute atomically — no risk window.

This requires fixing the `core apply` EVM path to respect `--strategy` (currently ignored for EVM).

---

## Work Areas

### WA1: Fix `core apply` EVM Path to Use Strategy Submitter

**Problem:** `runCoreApply()` in `typescript/cli/src/deploy/core.ts` ignores `--strategy` for EVM chains. It sends txs one-by-one via `multiProvider.sendTransaction()`. The AltVM path already respects the strategy.

**Changes:**

| File                                | Change                                                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/cli/src/deploy/core.ts` | Unify EVM and AltVM paths: when `--strategy` is provided, use `getSubmitterByStrategy()` + `submitter.submit(...transactions)` for EVM too. Fall back to sequential `multiProvider.sendTransaction()` only when no strategy is specified. |

**Result:** `hyperlane core apply --strategy safe-strategy.yaml` batches all txs (upgrade + config) into a single Safe proposal via `EV5GnosisSafeTxSubmitter` MultiSend.

---

### WA2: Proxy Upgrade Support in `EvmHookModule`

**Problem:** `updateIgpHook()` (`typescript/sdk/src/hook/EvmHookModule.ts:384`) only generates config update txs (beneficiary, gas oracle, overhead). It never detects outdated proxy implementations or generates `ProxyAdmin.upgrade()` transactions.

**Changes:**

| File                                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/sdk/src/hook/EvmHookModule.ts` — `updateIgpHook()` | Before config updates: (1) check if `deployedHook` is a proxy via `isProxy()` from `deploy/proxy.ts`, (2) read current impl via `proxyImplementation()`, (3) deploy new implementation (not proxied) via `deployer.deployContractWithName()`, (4) compare bytecode hashes — if different, generate `ProxyAdmin.upgrade(proxy, newImpl)` tx addressed to `this.args.addresses.proxyAdmin`. Then proceed with normal config update txs which write to the new storage layout. |

**Key details:**

- `upgrade` tx targets `this.args.addresses.proxyAdmin` (Safe-owned)
- `setDestinationGasConfigs` / `setTokenGasOracles` txs target `this.args.addresses.deployedHook` (the proxy, Safe-owned)
- The `upgrade` tx appears first in the returned `AnnotatedEV5Transaction[]`, config txs follow
- When submitted via Safe batch (WA1), they execute atomically
- **Idempotency:** if bytecodes match, skip the upgrade tx entirely

**Relevant code references:**

- `proxyImplementation()` — `typescript/sdk/src/deploy/proxy.ts:45` (reads EIP-1967 slot)
- `isProxy()` — `typescript/sdk/src/deploy/proxy.ts:106`
- `HyperlaneDeployer.upgradeAndInitialize()` — `typescript/sdk/src/deploy/HyperlaneDeployer.ts:608` (pattern reference, not reused directly)
- `ProxyAdmin__factory.createInterface().encodeFunctionData('upgrade', [proxy, newImpl])` for tx generation

---

### WA3: Per-Token Oracle Config in IgpSchema & Module

**Problem:** The entire TypeScript stack (schema, reader, deployer) treats IGP as native-only. The Solidity contract already supports `tokenGasOracles[feeToken][domain]` and `setTokenGasOracles()`, but the SDK has no way to configure them.

**Changes:**

| File                                                             | Change                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/sdk/src/hook/types.ts`                               | Extend `IgpSchema` with optional `tokenOracleConfigs?: z.record(ZHash, z.object({ oracleKey: z.string(), oracleConfig: z.record(OracleConfigSchema) }))`. Key = fee token address, value = oracle owner + per-remote-chain config. Existing `oracleKey`/`oracleConfig` remain for native (backwards-compatible). |
| `typescript/sdk/src/hook/EvmHookReader.ts` — `deriveIgpConfig()` | Accept optional `knownFeeTokens: Address[]`. For each `(token, domain)`, read `tokenGasOracles[token][domain]`, then read the oracle's exchange rate + gas price. Populate `tokenOracleConfigs`. The contract cannot enumerate fee tokens, so the list must be provided externally.                              |
| `typescript/sdk/src/hook/EvmHookModule.ts` — `deployIgpHook()`   | For each entry in `tokenOracleConfigs`: deploy a `StorageGasOracle`, configure via `setRemoteGasDataConfigs`, then call `igp.setTokenGasOracles()` with `TokenGasOracleConfig[]`.                                                                                                                                |
| `typescript/sdk/src/hook/EvmHookModule.ts` — `updateIgpHook()`   | Diff current vs target `tokenOracleConfigs`. Generate `setTokenGasOracles` txs for new/changed entries. Generate `StorageGasOracle.setRemoteGasDataConfigs` txs for updated exchange rates on existing oracles.                                                                                                  |
| `typescript/sdk/src/gas/utils.ts`                                | Add `getTokenStorageGasOracleConfig()` — same structure as `getLocalStorageGasOracleConfig()` but computes exchange rate as `remoteNativePrice / feeTokenPrice` (e.g., ETH gas cost denominated in USDC). Same 50% margin.                                                                                       |

---

### WA4: Infra — Fee Token Config & Oracle Generation

**Changes:**

| File                                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New: `typescript/infra/config/environments/mainnet3/feeTokens.ts` | Define fee token metadata per token: `{ USDC: { price: '1.00', decimals: 6, addresses: { ethereum: '0xA0b8...', arbitrum: '0xaf88...', ... } }, USDT: { price: '1.00', decimals: 6, addresses: { ... } }, oUSDT: { price: '1.00', decimals: 18, addresses: { ... } } }`. Source USDC/USDT addresses from existing `tokens` object in `typescript/infra/src/config/warp.ts` and `usdcTokenAddresses` in `cctp.ts`. Source oUSDT addresses from `getoUSDTTokenWarpConfig.ts` (xERC20 address `0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189` on most chains, lockbox contracts on ethereum/celo). |
| `typescript/infra/src/config/gas-oracle.ts`                       | Add `getAllTokenStorageGasOracleConfigs(chainNames, nativeTokenPrices, gasPrices, feeTokens, getOverhead)` — generates oracle configs per `(chain, feeToken, remoteDomain)`. Exchange rate = `remoteNativePrice / feeTokenPrice`. Same 50% margin, same min USD cost logic.                                                                                                                                                                                                                                                                                                                  |
| `typescript/infra/config/environments/mainnet3/igp.ts`            | Add `tokenOracleConfigs` to IGP config for chains that host warp routes for USDC/USDT/oUSDT. Build from `feeTokens.ts` addresses + `getAllTokenStorageGasOracleConfigs()`.                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Target chains by token:**

- **USDC** (~30 chains): ethereum, arbitrum, base, optimism, polygon, bsc, unichain, ink, worldchain, avalanche, hyperevm, linea, monad, lisk, zeronetwork, appchain, superseed, solanamainnet, subtensor, celo, sei, sonic, plume, etc.
- **USDT** (~15 EVM chains): ethereum, arbitrum, mantle, mode, polygon, scroll, zeronetwork, bsc, base, optimism, + oUSDT overlap chains
- **oUSDT** (23 chains): ethereum, celo, optimism, base, unichain, ink, soneium, mode, fraxtal, superseed, lisk, worldchain, sonic, bitlayer, ronin, mantle, metis, linea, metal, bob, hashkey, swell, botanix

---

### WA5: ICA Router Fee Token Approvals

**Problem:** The ICA router approves the top-level hook (FallbackRoutingHook) for ERC20 fee tokens during dispatch, but the IGP is a **child** hook inside a `StaticAggregationHook`. The IGP calls `transferFrom` directly, so it needs a separate pre-approval via `approveFeeTokenForHook`.

**Changes:**

| File                                                 | Change                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/infra/scripts/deploy.ts` (lines 173-195) | Add `feeTokenApprovals` to the ICA config builder. For each chain with ERC20 fees enabled: `{ feeToken: <USDC/USDT/oUSDT address>, hook: <IGP proxy address> }`. The IGP address is the child hook inside the aggregation — resolve from deployed core addresses. |
| Existing ICA routers (123 chains)                    | Use `EvmIcaModule.update()` to generate `approveFeeTokenForHook` txs. `approveFeeTokenForHook` is **permissionless** (no governance needed). Only required on chains where ERC20 IGP fees are enabled.                                                            |

**Relevant Solidity:** `InterchainAccountRouter.approveFeeTokenForHook(address _feeToken, address _hook)` at `solidity/contracts/middleware/InterchainAccountRouter.sol:183`. Sets infinite approval — safe because the ICA router never holds user funds.

---

### WA6: Checker, Governor & Bytecode Hashes

**Changes:**

| File                                                  | Change                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript/sdk/src/gas/types.ts`                     | Add `TokenGasOracles` to `IgpViolationType` enum.                                                                                                                                             |
| `typescript/sdk/src/gas/HyperlaneIgpChecker.ts`       | Validate `tokenOracleConfigs` — for each `(feeToken, domain)`, check that `tokenGasOracles[feeToken][domain]` matches the config oracle. Emit `IgpViolationType.TokenGasOracles` on mismatch. |
| `typescript/infra/src/govern/HyperlaneIgpGovernor.ts` | Handle `TokenGasOracles` violation — generate `setTokenGasOracles(TokenGasOracleConfig[])` tx.                                                                                                |
| `typescript/sdk/src/consts/bytecode.ts`               | Update `INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH` and `OPT_INTERCHAIN_GAS_PAYMASTER_BYTECODE_HASH` after recompiling. The implementation bytecode changed in the audit merge.                   |

---

### WA7: Testing via Registry Forks

| Step | Action                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Pick representative chains: ethereum, arbitrum, base, optimism                                                                                     |
| 2    | Fork with Anvil (`anvil --fork-url <rpc>`) or via `hyperlane warp fork`                                                                            |
| 3    | Impersonate Safe owner + ProxyAdmin owner via `anvil_impersonateAccount`                                                                           |
| 4    | Deploy new IGP implementation to fork                                                                                                              |
| 5    | Run `hyperlane core apply --strategy safe-strategy.yaml` with updated IGP config (including `tokenOracleConfigs`)                                  |
| 6    | Verify: the Safe batch contains `upgrade` + `setDestinationGasConfigs` + `setTokenGasOracles` in order                                             |
| 7    | Execute the batch. Verify `destinationGasConfigs(domain)` returns correct values, `tokenGasOracles[USDC][domain]` is set, `domains()` is populated |
| 8    | Dispatch a test message with `StandardHookMetadata.formatWithFeeToken(0, 100000, refund, USDC_ADDRESS)` — verify IGP collects USDC                 |
| 9    | Verify `quoteGasPayment(USDC, domain, gasLimit)` returns a reasonable USD-denominated quote                                                        |

---

## Execution Order

```
Phase 1 (parallel, no dependencies):
  WA1: Fix core apply EVM strategy support
  WA3: IgpSchema + reader + module per-token oracle support
  WA6: Update bytecode hashes (quick, independent)

Phase 2 (depends on Phase 1):
  WA2: Proxy upgrade in EvmHookModule (needs WA3 schema for token oracle txs)
  WA4: Infra fee token config (needs WA3 schema)

Phase 3 (depends on Phase 2):
  WA5: ICA approvals (needs WA4 for token addresses + hook addresses)
  WA7: Fork testing (needs WA1 + WA2 + WA3 + WA4)

Phase 4:
  Production rollout via core apply + Safe strategy on target chains
```

---

## Storage Layout Context

After proxy upgrade, the IGP storage layout is:

| Slot      | Variable                                                                | Notes                                                                                                                          |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Inherited | `OwnableUpgradeable` internals                                          | `_initialized`, `_owner` — unchanged                                                                                           |
| N         | `__deprecated_destinationGasConfigs` (`uint256`)                        | Placeholder for old mapping. Old data at `keccak256(domain, N)` is unreachable.                                                |
| N+1       | `beneficiary` (`address`)                                               | Unchanged                                                                                                                      |
| N+2       | `tokenGasOracles` (`mapping(address => mapping(uint32 => IGasOracle))`) | **New.** Empty after upgrade. Must be seeded via `setDestinationGasConfigs` (for native) and `setTokenGasOracles` (for ERC20). |
| N+3       | `destinationGasOverhead` (`mapping(uint32 => uint256)`)                 | **New.** Empty after upgrade. Seeded by `setDestinationGasConfigs`.                                                            |
| EIP-7201  | `EnumerableDomainSet.DomainSetStorage`                                  | Namespaced storage. Seeded by `setDestinationGasConfigs` (native oracle add/remove triggers domain tracking).                  |

The `destinationGasConfigs(domain)` view function reads from `tokenGasOracles[NATIVE_TOKEN][domain]` and `destinationGasOverhead[domain]` — **not** from the deprecated mapping. Until these are seeded, all quotes and dispatches revert with `"IGP: no gas oracle for domain <N>"`.

---

## Token Address Sources

| Token | Source                                                                                 | Example Address (Ethereum)                                                                                        |
| ----- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| USDC  | `tokens` in `typescript/infra/src/config/warp.ts` + `usdcTokenAddresses` in `cctp.ts`  | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`                                                                      |
| USDT  | `tokens` in `typescript/infra/src/config/warp.ts`                                      | `0xdac17f958d2ee523a2206206994597c13d831ec7`                                                                      |
| oUSDT | `getoUSDTTokenWarpConfig.ts` — xERC20 address on most chains, lockbox on ethereum/celo | `0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189` (xERC20), `0x6D265C7dD8d76F25155F1a7687C693FDC1220D12` (ETH lockbox) |

---

## Deferred Items

- **Oracle update automation:** DEPLOYER key needs to update ERC20 oracle rates on a regular cadence (same infra job, more oracle contracts).
- **Grafana dashboards:** Add panels for ERC20 `GasPayment` events (filter by non-zero `feeToken`).
- **Governance batching cadence:** How Safe multi-send proposals are reviewed/executed across chains — deferred.
- **Stablecoin price feed:** USDC/USDT/oUSDT hardcoded at $1.00. If volatile ERC20 fee tokens are added later, a price feed integration would be needed.
