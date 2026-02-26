# E2E Test Conventions

Guidelines for writing and updating rebalancer e2e tests.

## 1. Assert total action counts at each stage

Don't just filter for the action type you care about. Assert the total count first, then find/filter within it. This catches unexpected extra actions.

```ts
// Good
const actionsAfterBridge = await context.tracker.getActionsForIntent(intent.id);
expect(actionsAfterBridge.length).to.equal(2); // 1 deposit + 1 movement
const movementAction = actionsAfterBridge.find(
  (a) => a.type === 'inventory_movement',
);

// Bad — doesn't catch unexpected extra actions
const movementActions = actionsAfterBridge.filter(
  (a) => a.type === 'inventory_movement' && a.status === 'complete',
);
expect(movementActions.length).to.equal(1);
```

## 2. Use `find` + `expect(x).to.exist` for single items

When you expect exactly one action of a type, use `find` instead of `filter` + length check. It reads as "there should be one of these" and gives you a non-null reference.

```ts
// Good
const movementAction = actionsAfterBridge.find(
  (a) => a.type === 'inventory_movement',
);
expect(movementAction).to.exist;
expect(movementAction!.origin).to.equal(DOMAIN_IDS.anvil1);

// Bad — extra ceremony for the same thing
const completedMovementActions = actionsAfterBridge.filter(
  (a) => a.type === 'inventory_movement' && a.status === 'complete',
);
expect(completedMovementActions.length).to.equal(1);
expect(completedMovementActions[0].origin).to.equal(DOMAIN_IDS.anvil1);
```

## 3. Don't over-filter — let aggregate assertions catch problems

Don't add `status === 'complete'` to filter predicates when a downstream assertion (like summing amounts) will fail anyway if an action is in the wrong state. Over-filtering hides bugs.

```ts
// Good — if a deposit is incomplete, totalDeposited won't match
const allDeposits = finalActions.filter((a) => a.type === 'inventory_deposit');
expect(allDeposits.length).to.equal(2);
const totalDeposited = allDeposits.reduce((sum, a) => sum + a.amount, 0n);
expect(totalDeposited).to.equal(activeIntent.amount);

// Bad — status filter masks a deposit stuck in 'in_progress'
const allDeposits = finalActions.filter(
  (a) => a.type === 'inventory_deposit' && a.status === 'complete',
);
expect(allDeposits.length).to.equal(2);
```

Exception: filter by status when you're specifically testing state transitions (e.g. "after relay, this action should be complete").

## 4. Use `getRouterBalances` helper for balance snapshots

Every test that asserts router balance changes repeats the same loop. Extract it into a shared helper and call it before/after the operation under test.

```ts
// In test helpers
async function getRouterBalances(
  localProviders: Map<string, providers.JsonRpcProvider>,
  addresses: NativeDeployedAddresses,
): Promise<Record<string, BigNumber>> {
  const balances: Record<string, BigNumber> = {};
  for (const chain of TEST_CHAINS) {
    const provider = localProviders.get(chain)!;
    balances[chain] = await provider.getBalance(
      addresses.monitoredRoute[chain],
    );
  }
  return balances;
}

// In tests
const before = await getRouterBalances(localProviders, nativeDeployedAddresses);
// ... execute cycle, relay, etc.
const after = await getRouterBalances(localProviders, nativeDeployedAddresses);
```

## 5. Use `classifyChains` helper for surplus/deficit/neutral

Tests frequently need to identify which chain is the deficit (destination), which funded the transfer (surplus), and which was uninvolved (neutral). Extract this into a helper that derives the classification from a single deposit action rather than hardcoding chain names.

```ts
interface ChainRoles {
  deficitChain: string;
  surplusChain: string;
  neutralChain?: string;
}

function classifyChains(
  deficitChain: string,
  depositAction: RebalanceAction,
): ChainRoles {
  // Surplus chain is where the router pays out on message delivery.
  // For inventory deposits, that's the action's destination (swapped direction).
  const surplusChain = chainFromDomain(depositAction.destination);
  const neutralChain = TEST_CHAINS.find(
    (c) => c !== deficitChain && c !== surplusChain,
  );
  return { deficitChain, surplusChain, neutralChain };
}

// In tests
const { surplusChain, neutralChain } = classifyChains('anvil2', depositAction);

expect(after.anvil2.gt(before.anvil2)).to.be.true;
expect(after[surplusChain].lt(before[surplusChain])).to.be.true;
if (neutralChain) {
  expect(after[neutralChain].eq(before[neutralChain])).to.be.true;
}
```

## 6. Use `withInventorySignerBalances` for signer wallet setup

Don't call `anvil_setBalance` on the inventory signer directly in tests. Use the builder's `withInventorySignerBalances` method with a preset name or inline config.

```ts
// Good — preset name from INVENTORY_SIGNER_PRESETS in routes.ts
const context = await new TestRebalancerBuilder(deploymentManager, multiProvider)
  .withStrategy(buildInventoryMinAmountStrategyConfig(addresses))
  .withInventoryConfig({ inventorySignerKey: ANVIL_USER_PRIVATE_KEY, nativeDeployedAddresses })
  .withInventorySignerBalances('SIGNER_PARTIAL_ANVIL2')
  .withExecutionMode('execute')
  .build();

// Also accepted — inline Record<string, BigNumber> for one-off scenarios
.withInventorySignerBalances({ anvil2: BigNumber.from('500000000000000000') })

// Bad — setting balances outside the builder
const signer = new ethers.Wallet(ANVIL_USER_PRIVATE_KEY);
await provider.send('anvil_setBalance', [signer.address, '0x...']);
```

Available presets: `SIGNER_PARTIAL_ANVIL2`, `SIGNER_LOW_ALL`, `SIGNER_ONLY_ANVIL1`, `SIGNER_SPLIT_SOURCES`, `SIGNER_FUNDED_ANVIL1`, `SIGNER_PARTIAL_ANVIL3`, `SIGNER_ZERO_ANVIL3`, `SIGNER_WEIGHTED_LOW_ALL`, `SIGNER_WEIGHTED_BRIDGE_SOURCES`.

## 7. Use named constants for strategy-derived values

Don't hardcode magic numbers like `2000000000000000000n`. Derive expected values from the strategy config constants exported in `routes.ts`.

```ts
// Good — derived from strategy config
import { INVENTORY_MIN_AMOUNT_TARGET_WEI } from './fixtures/routes.js';
const expectedDeficit = INVENTORY_MIN_AMOUNT_TARGET_WEI.toBigInt();
expect(activeIntent.amount).to.equal(expectedDeficit);

// Bad — hardcoded magic number
expect(activeIntent.amount).to.equal(2000000000000000000n);
```

Available constants: `INVENTORY_MIN_AMOUNT_MIN` (`'1'`), `INVENTORY_MIN_AMOUNT_TARGET` (`'2'`), `INVENTORY_MIN_AMOUNT_TARGET_WEI` (target as wei BigNumber).

## 8. Use balance presets for router balances

Don't inline `BigNumber.from(...)` objects in `.withInventoryBalances()` when a preset in `BALANCE_PRESETS` matches your scenario. Add a new preset if the scenario is reusable.

```ts
// Good — named preset
.withInventoryBalances('INVENTORY_EMPTY_DEST')
.withInventoryBalances('INVENTORY_MULTI_DEFICIT')

// Acceptable — inline for truly one-off scenarios
.withInventoryBalances({
  anvil1: BigNumber.from('9000000000000000000'),
  anvil2: BigNumber.from(0),
  anvil3: BigNumber.from(0),
})

// Bad — duplicating values that already exist as a preset
.withInventoryBalances({
  anvil1: BigNumber.from('5000000000000000000'),
  anvil2: BigNumber.from('0'),
  anvil3: BigNumber.from('5000000000000000000'),
})
// ^ This is INVENTORY_EMPTY_DEST — use the preset.
```

These helpers and conventions eliminate repeated boilerplate across tests and make intent immediately clear.

## 9. Assert state after each cycle — no loop-to-completion

Multi-cycle tests must check state after **every** cycle. Looping with `for (let i = 0; i < N; i++)` until completion is an antipattern — it hides the per-cycle progression and makes failures impossible to diagnose.

```ts
// Good — explicit per-cycle assertions
await executeCycle(context);
await syncAndRelay(context);
// Check cycle 1 state
expect(partialIntents[0].completedAmount > 0n).to.be.true;
expect(actions.length).to.equal(2);

await executeCycle(context);
await syncAndRelay(context);
// Check cycle 2 state
expect(partialIntents[0].completedAmount > c1Amount).to.be.true;
expect(actions.length).to.equal(3);

// ... continue until completion

// Bad — loop hides what happens per cycle
for (let i = 0; i < 5; i++) {
  await executeCycle(context);
  await syncAndRelay(context);
}
expect(finalIntent.status).to.equal('complete');
```

Each cycle should assert:

- Active/partial intent state (count, completedAmount, remaining)
- Action counts by type (deposits, movements)
- Monotonic progress (completedAmount increasing across cycles)
