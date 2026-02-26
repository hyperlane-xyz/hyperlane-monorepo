import { expect } from 'chai';
import { BigNumber, Wallet, providers } from 'ethers';

import {
  HyperlaneCore,
  MultiProvider,
  revertToSnapshot,
  snapshot,
} from '@hyperlane-xyz/sdk';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerConfigSchema,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  ANVIL_USER_PRIVATE_KEY,
  type Erc20InventoryDeployedAddresses,
  TEST_CHAINS,
} from './fixtures/routes.js';
import {
  MIXED_INVENTORY_CHAIN,
  MIXED_INVENTORY_OVERRIDE,
  MIXED_MOVABLE_CHAINS,
  MixedLocalDeploymentManager,
} from './harness/MixedLocalDeploymentManager.js';
import { MockExternalBridge } from './harness/MockExternalBridge.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import {
  type TestRebalancerContext,
  TestRebalancerBuilder,
} from './harness/TestRebalancer.js';

function buildMixedWeightedStrategyConfig(
  addresses: Erc20InventoryDeployedAddresses,
): StrategyConfig[] {
  return [
    {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: {
        anvil1: {
          weighted: { weight: 60n, tolerance: 5n },
          bridge: addresses.bridgeRoute.anvil1,
          executionType: ExecutionType.MovableCollateral,
          override: {
            [MIXED_INVENTORY_CHAIN]: {
              ...MIXED_INVENTORY_OVERRIDE,
            },
          },
        },
        anvil2: {
          weighted: { weight: 20n, tolerance: 5n },
          bridge: addresses.bridgeRoute.anvil2,
          executionType: ExecutionType.MovableCollateral,
          override: {
            [MIXED_INVENTORY_CHAIN]: {
              ...MIXED_INVENTORY_OVERRIDE,
            },
          },
        },
        anvil3: {
          weighted: { weight: 20n, tolerance: 5n },
          bridge: addresses.bridgeRoute.anvil3,
          executionType: ExecutionType.MovableCollateral,
        },
      },
    },
  ];
}

describe('Mixed WeightedStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: MixedLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: Erc20InventoryDeployedAddresses;
  let mixedStrategyConfig: StrategyConfig[];
  let mockBridge: MockExternalBridge;

  const inventorySignerAddress = new Wallet(ANVIL_USER_PRIVATE_KEY).address;

  async function buildContext(
    inventoryBalances: string | Record<string, BigNumber>,
  ): Promise<TestRebalancerContext> {
    return new TestRebalancerBuilder(deploymentManager, multiProvider)
      .withStrategy(mixedStrategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses: deployedAddresses,
      })
      .withMockExternalBridge(mockBridge)
      .withInventoryBalances(inventoryBalances)
      .build();
  }

  before(async function () {
    deploymentManager = new MixedLocalDeploymentManager(inventorySignerAddress);
    const ctx = await deploymentManager.start();
    multiProvider = ctx.multiProvider;
    localProviders = ctx.providers;
    deployedAddresses = ctx.deployedAddresses;

    const coreAddresses: Record<string, Record<string, string>> = {};
    for (const chain of TEST_CHAINS) {
      coreAddresses[chain] = {
        mailbox: deployedAddresses.chains[chain].mailbox,
        interchainSecurityModule: deployedAddresses.chains[chain].ism,
      };
    }
    hyperlaneCore = HyperlaneCore.fromAddressesMap(
      coreAddresses,
      multiProvider,
    );

    mixedStrategyConfig = buildMixedWeightedStrategyConfig(deployedAddresses);
    mockBridge = new MockExternalBridge(
      deployedAddresses,
      multiProvider,
      hyperlaneCore,
      'erc20',
    );

    snapshotIds = new Map();
    for (const [chain, provider] of localProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    mockBridge.reset();
    for (const [chain, provider] of localProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      snapshotIds.set(chain, await snapshot(provider));
      Reflect.set(provider, '_maxInternalBlockNumber', -1);
      Reflect.set(provider, '_internalBlockNumber', null);
    }
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  it('accepts mixed movable + inventory override config in schema', function () {
    const configResult = RebalancerConfigSchema.safeParse({
      warpRouteId: 'USDC/test-mixed-weighted',
      strategy: [
        {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            anvil1: {
              weighted: { weight: 60, tolerance: 5 },
              bridge: deployedAddresses.bridgeRoute.anvil1,
              executionType: ExecutionType.MovableCollateral,
              override: {
                [MIXED_INVENTORY_CHAIN]: {
                  ...MIXED_INVENTORY_OVERRIDE,
                },
              },
            },
            anvil2: {
              weighted: { weight: 20, tolerance: 5 },
              bridge: deployedAddresses.bridgeRoute.anvil2,
              executionType: ExecutionType.MovableCollateral,
              override: {
                [MIXED_INVENTORY_CHAIN]: {
                  ...MIXED_INVENTORY_OVERRIDE,
                },
              },
            },
            anvil3: {
              weighted: { weight: 20, tolerance: 5 },
              bridge: deployedAddresses.bridgeRoute.anvil3,
              executionType: ExecutionType.MovableCollateral,
            },
          },
        },
      ],
      inventorySigners: {
        ethereum: inventorySignerAddress,
      },
      externalBridges: {
        lifi: {
          integrator: 'test',
        },
      },
    });

    expect(configResult.success).to.equal(true);
  });

  it('includes override-only inventory chain and creates both rebalancers', async function () {
    const context = await buildContext('ERC20_INVENTORY_BALANCED');

    const { rebalancers, inventoryConfig } =
      await context.contextFactory.createRebalancers(
        context.tracker,
        undefined,
        {
          [ExternalBridgeType.LiFi]: mockBridge,
        },
      );

    expect(inventoryConfig).to.exist;
    expect(inventoryConfig!.chains).to.deep.equal([MIXED_INVENTORY_CHAIN]);
    expect(rebalancers.map((r) => r.rebalancerType).sort()).to.deep.equal([
      'inventory',
      'movableCollateral',
    ]);
  });

  it('routes inventory destination through inventory and movable destination through movable collateral', async function () {
    const context = await buildContext({
      anvil1: BigNumber.from('10000000000'),
      anvil2: BigNumber.from('0'),
      anvil3: BigNumber.from('0'),
    });

    const monitor = context.createMonitor(0);
    const event = await getFirstMonitorEvent(monitor);
    const cycleResult = await context.orchestrator.executeCycle(event);

    const routeToInventory = cycleResult.proposedRoutes.find(
      (route) => route.destination === MIXED_INVENTORY_CHAIN,
    );
    expect(routeToInventory).to.exist;
    expect(routeToInventory!.executionType).to.equal(ExecutionType.Inventory);

    const movableDestination = MIXED_MOVABLE_CHAINS.find(
      (chain) => chain !== 'anvil1',
    )!;
    const routeToMovable = cycleResult.proposedRoutes.find(
      (route) => route.destination === movableDestination,
    );
    expect(routeToMovable).to.exist;
    expect(routeToMovable!.executionType).to.equal(
      ExecutionType.MovableCollateral,
    );

    const inProgressActions = await context.tracker.getInProgressActions();
    const hasInventoryExecution = inProgressActions.some(
      (action) =>
        action.type === 'inventory_deposit' &&
        multiProvider.getChainName(action.destination) ===
          MIXED_INVENTORY_CHAIN,
    );
    const hasMovableExecution = inProgressActions.some(
      (action) =>
        action.type === 'rebalance_message' &&
        multiProvider.getChainName(action.destination) === movableDestination,
    );

    expect(hasInventoryExecution).to.equal(true);
    expect(hasMovableExecution).to.equal(true);
  });
});
