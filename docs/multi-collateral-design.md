# MultiCollateral Design Plan

## Context

Replace sUSD Hub + ICA design (2 messages, non-atomic) with direct peer-to-peer collateral routing (1 message, atomic). Each deployed instance holds collateral for one ERC20. Enrolled routers are other MultiCollateral instances (same or different token).

**Decisions:** Fees on `localTransferTo` (ITokenFee gets params, decides by domain). Batch-only enrollment. Config like normal warp routes (movable collateral, owners, etc).

---

## Phase 1: Contract (DONE)

**File:** `solidity/contracts/token/extensions/MultiCollateral.sol`

**Extends:** `HypERC20Collateral` — inherits rebalancing, LP staking, fees, decimal scaling, `_transferFromSender`/`_transferTo`.

### Storage

```solidity
mapping(uint32 domain => mapping(bytes32 router => bool)) public enrolledRouters;
```

Single mapping for both cross-chain and local routers. Local routers use `localDomain` as key.

### Functions

**Router management (onlyOwner, batch-only):**

- `enrollRouters(uint32[] domains, bytes32[] routers)` — batch enroll
- `unenrollRouters(uint32[] domains, bytes32[] routers)` — batch unenroll

**`handle()` override** (overrides `Router.handle`):

```solidity
function handle(
  uint32 _origin,
  bytes32 _sender,
  bytes calldata _message
) external payable override onlyMailbox {
  require(
    _isRemoteRouter(_origin, _sender) || enrolledRouters[_origin][_sender],
    'MC: unauthorized router'
  );
  _handle(_origin, _sender, _message);
}
```

**`transferRemoteTo()`** — cross-chain to specific router:

- Checks `_isRemoteRouter || enrolledRouters`
- Reuses fee pipeline from TokenRouter
- Dispatches directly to target (bypasses `_Router_dispatch` which hardcodes enrolled router)

**`localTransferTo()`** — same-chain swap with fees:

- Checks `enrolledRouters[localDomain]`
- Charges fee via `_feeRecipientAndAmount(localDomain, ...)`
- Calls `MultiCollateral(_targetRouter).receiveLocalSwap(canonical, recipient)`

**`receiveLocalSwap()`** — called by local enrolled router

**`quoteTransferRemoteTo()`** — returns 3 quotes: native gas, token+fee, external fee

### Events

- `RouterEnrolled(uint32 indexed domain, bytes32 indexed router)`
- `RouterUnenrolled(uint32 indexed domain, bytes32 indexed router)`
- Reuse `SentTransferRemote` from TokenRouter

---

## Phase 2: Forge Tests (DONE)

**File:** `solidity/test/token/extensions/MultiCollateral.t.sol`

22 tests covering: cross-chain same-stablecoin, cross-chain cross-stablecoin, same-chain swap, fees, decimal scaling (6↔18), unauthorized reverts, owner-only enrollment, bidirectional transfers, batch enroll/unenroll, events, quoting.

---

## Phase 3: SDK Registration (DONE)

| File                                             | Change                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `typescript/sdk/src/token/config.ts`             | `TokenType.multiCollateral`, movable map entry                  |
| `typescript/sdk/src/token/types.ts`              | `MultiCollateralTokenConfigSchema` with `enrolledRouters` field |
| `typescript/sdk/src/token/contracts.ts`          | `MultiCollateral__factory` import/mapping                       |
| `typescript/sdk/src/token/deploy.ts`             | Constructor/init args + batch `enrollRouters()` post-deploy     |
| `typescript/sdk/src/token/TokenStandard.ts`      | `EvmHypMultiCollateral` enum + mappings                         |
| `typescript/sdk/src/token/Token.ts`              | Adapter mapping → `EvmMovableCollateralAdapter`                 |
| `typescript/sdk/src/token/tokenMetadataUtils.ts` | `isMultiCollateralTokenConfig`                                  |

---

## Phase 4: CLI E2E Tests (DONE)

**File:** `typescript/cli/src/tests/ethereum/warp/warp-multi-peer.e2e-test.ts`

3 tests:

1. Same-stablecoin round trip via CLI `transferRemote`
2. Cross-stablecoin via `transferRemoteTo` (USDC→USDT, decimal scaling)
3. Same-chain local swap via `localTransferTo`

Also added `multiCollateral` to `ignoreTokenTypes` in `generateWarpConfigs`.

---

## Verification

```bash
# Solidity (22/22 pass)
forge test --match-contract MultiCollateralTest -vvv

# SDK builds (pre-existing type errors only)
pnpm -C typescript/sdk build

# CLI e2e (slow)
pnpm -C typescript/cli test:ethereum:e2e
```
