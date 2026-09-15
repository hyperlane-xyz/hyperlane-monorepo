# deBridge source-swap validation

`debridge-bsc-forwarder.json` is an unsigned BSC USDT → Ethereum USDT
`create-tx` response captured on 2026-09-15. It preserves the provider payload.
The validator **rejects this original response**: surplus goes to provider-selected
addresses and the nested order restricts its taker. Requesting
`srcChainRefundAddress` did not change the surplus recipient in a fresh response.

`supportedForwarderData()` constructs a positive test case by returning surplus
to the inventory signer and removing the restricted taker. Production code never
rewrites these fields. This fixture proves support for the decoded path, not that
deBridge will currently quote that path with our required recipients and policy.
Another observed response selected router `0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5`;
that router remains unsupported.

## Supported path and trust boundaries

1. Known BSC forwarder, exact requested USDT input, empty permit, USDC intermediate,
   signer refund, and known DLN source target.
2. Known 0x AllowanceHolder and pinned Settler; registry must identify that Settler
   as current or previous. A paused registry, expired funding deadline (checked
   against the latest source block) or RPC error blocks approval.
3. Exact source funding; single-hop Pancake Infinity USDT → USDC fills with no
   hooks, unrelated assets, arbitrary calls, or third-party recipients. Optional
   positive slippage goes to the signer.
4. Nested DLN order preserves the intermediate input, destination token/chain,
   minimum output, recipient and authorities. Existing restrictions on affiliate
   fees, permits, restricted takers and external calls still apply.
5. Canonical encoding at each ABI boundary; exact approval only after validation.

The forwarder checks its actual intermediate balance increase against the outer
minimum before creating the order, in the same transaction. The inner aggregator
minimum may be weaker without weakening that outer check. Validation still trusts
the deployed contracts, token behavior and RPC; it does not simulate settlement or
prove solver availability. Unknown router/action/deployment variants fail closed.

Source references:

- [deBridge deployed contracts](https://docs.debridge.com/dln-details/overview/deployed-contracts).
  BSC forwarder implementation inspected:
  `0xce56012e880851baa234cd092af516a0fca9cfe3`.
- [0x Settler source](https://github.com/0xProject/0x-settler/tree/25b9af082739d8ca992123d7145e60ca78a839cf):
  `ISettlerActions.sol`, `SettlerBase.sol`, `core/PancakeInfinity.sol`,
  `allowanceholder/AllowanceHolderBase.sol`. This revision has the four-argument
  `POSITIVE_SLIPPAGE` used in the fixture.
- [0x registry verification](https://github.com/0xProject/0x-settler/blob/25b9af082739d8ca992123d7145e60ca78a839cf/README.md).
  `ownerOf(2)` at BSC block 122010569 returned the pinned Settler address.

## Tests

From `typescript/rebalancer`, use Node 26 and installed dependencies:

```sh
pnpm exec mocha --import=tsx src/bridges/deBridgeForwarderValidation.test.ts src/bridges/DeBridgeBridge.test.ts --exit
```

Mutation tests cover nested field changes, arbitrary calls, permits, hooks,
redirected surplus, allowance mismatches, noncanonical encoding and retired/paused
deployments. Adapter tests assert rejection before approval/submission and exact
approval to the validated forwarder. Existing direct-order tests remain in place.

The separate fork test requires a disposable local Anvil and BSC RPC serving the
pinned historical state. It impersonates/funds the fixture signer **only locally**.
It also refreshes the captured funding deadline in the constructed test calldata.
That mutation tests the call path; it does not make the old provider quote fresh.

```sh
anvil --fork-url "$BSC_ARCHIVE_RPC" --fork-block-number 122011359 --host 127.0.0.1 --port 8597
DEBRIDGE_FORK_RPC=http://127.0.0.1:8597 pnpm exec mocha --import=tsx src/bridges/deBridgeForwarderValidation.fork-test.ts --exit
```

`DEBRIDGE_FORK_BLOCK` can explicitly select a different fork block; record that
block with results. Old quotes may no longer meet their minimum at another block.
The test checks source debit, allowance consumption, the emitted DLN order and
atomic rollback. It does not test destination fulfillment. Network failures must
fail the suite and must not be counted as successful rollback tests.

Before enabling execution, require an unmodified fresh provider response that
passes validation, a passing fork execution, and separate source-to-destination
settlement verification. Unit success alone does not satisfy those gates.

Verified on 2026-09-15: rebalancer TypeScript build, lint (three existing warnings),
497 unit tests, and both constructed-fixture fork tests at BSC block 122011359.
The rollback test also checks the forwarder's `NotEnoughSrcFundsIn` revert data.
