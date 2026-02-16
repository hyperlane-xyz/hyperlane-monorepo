import { expect } from 'chai';
import { BigNumber, providers } from 'ethers';

import { MultiProvider, revertToSnapshot, snapshot } from '@hyperlane-xyz/sdk';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
  type TestChain,
} from './fixtures/routes.js';
import {
  ScriptedBridgeMock,
  approveInventorySignerForMonitoredRoutes,
  executeInventoryCycle,
  injectInventoryRebalancer,
  inventoryBalances,
  setInventorySignerBalances,
} from './harness/InventoryTestHelpers.js';
import {
  type LocalDeploymentContext,
  LocalDeploymentManager,
} from './harness/LocalDeploymentManager.js';
import { TestRebalancer } from './harness/TestRebalancer.js';

describe('WeightedStrategy Inventory E2E', function () {
  this.timeout(300_000);

  let deploymentManager: LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let deployedAddresses: DeployedAddresses;
  let inventorySignerAddress: string;
  let weightedInventoryStrategyConfig: StrategyConfig[];

  before(async function () {
    deploymentManager = new LocalDeploymentManager();
    const ctx: LocalDeploymentContext = await deploymentManager.start();
    multiProvider = ctx.multiProvider;
    localProviders = ctx.providers;
    deployedAddresses = ctx.deployedAddresses;

    weightedInventoryStrategyConfig = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          anvil1: {
            weighted: { weight: 60n, tolerance: 5n },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
          anvil2: {
            weighted: { weight: 20n, tolerance: 5n },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
          anvil3: {
            weighted: { weight: 20n, tolerance: 5n },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
          },
        },
      },
    ];

    inventorySignerAddress = await approveInventorySignerForMonitoredRoutes(
      localProviders,
      deployedAddresses,
    );

    snapshotIds = new Map();
    for (const [chain, provider] of localProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  afterEach(async function () {
    for (const [chain, provider] of localProviders) {
      const id = snapshotIds.get(chain)!;
      await revertToSnapshot(provider, id);
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  it('handles multiple strategy intents with single-intent inventory execution', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedInventoryStrategyConfig)
      .withBalances({
        anvil1: BigNumber.from('9000000000'),
        anvil2: BigNumber.from('800000000'),
        anvil3: BigNumber.from('200000000'),
      })
      .withExecutionMode('execute')
      .build();

    injectInventoryRebalancer(context, new ScriptedBridgeMock(), inventorySignerAddress);

    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 2_000_000_000n,
        anvil3: 2_000_000_000n,
      }),
    );

    const cycleResult = await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    expect(cycleResult.proposedRoutes.length).to.equal(2);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    const intent = activeIntents[0];
    expect(intent.executionMethod).to.equal('inventory');

    const depositActions = await context.tracker.getActionsByType('inventory_deposit');
    expect(depositActions.length).to.equal(1);

    const firstProposedRoute = cycleResult.proposedRoutes[0];
    expect(intent.origin).to.equal(
      DOMAIN_IDS[firstProposedRoute.origin as TestChain],
    );
    expect(intent.destination).to.equal(
      DOMAIN_IDS[firstProposedRoute.destination as TestChain],
    );
    expect(intent.amount).to.equal(firstProposedRoute.amount);
  });

  it('handles multiple bridge movements in one cycle', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(weightedInventoryStrategyConfig)
      .withBalances({
        anvil1: BigNumber.from('1000000000'),
        anvil2: BigNumber.from('4500000000'),
        anvil3: BigNumber.from('4500000000'),
      })
      .withExecutionMode('execute')
      .build();

    const bridge = new ScriptedBridgeMock();
    bridge.enqueuePlan({});
    bridge.enqueuePlan({});
    injectInventoryRebalancer(context, bridge, inventorySignerAddress);

    await setInventorySignerBalances(
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
      inventoryBalances({
        anvil2: 1_500_000_000n,
        anvil3: 1_500_000_000n,
      }),
    );

    const cycleResult = await executeInventoryCycle(
      context,
      localProviders,
      deployedAddresses,
      inventorySignerAddress,
    );

    expect(cycleResult.proposedRoutes.length).to.equal(2);

    const activeIntents = await context.tracker.getActiveRebalanceIntents();
    expect(activeIntents.length).to.equal(1);
    const intentId = activeIntents[0].id;

    const movementActions = (
      await context.tracker.getActionsByType('inventory_movement')
    ).filter((a) => a.intentId === intentId);
    expect(movementActions.length).to.equal(2);

    const movementOrigins = new Set(movementActions.map((a) => a.origin));
    expect(movementOrigins.has(DOMAIN_IDS.anvil2)).to.be.true;
    expect(movementOrigins.has(DOMAIN_IDS.anvil3)).to.be.true;
    expect(bridge.executeCalls.length).to.equal(2);
  });
});
