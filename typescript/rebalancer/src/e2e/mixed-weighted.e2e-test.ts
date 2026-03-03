import { expect } from 'chai';
import { ethers, providers } from 'ethers';

import { MultiProvider, revertToSnapshot, snapshot } from '@hyperlane-xyz/sdk';

import {
  ExecutionType,
  ExternalBridgeType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';

import {
  ANVIL_USER_PRIVATE_KEY,
  DOMAIN_IDS,
  type Erc20InventoryDeployedAddresses,
} from './fixtures/routes.js';
import { Erc20InventoryLocalDeploymentManager } from './harness/Erc20InventoryLocalDeploymentManager.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import { TestRebalancer } from './harness/TestRebalancer.js';

describe('Mixed WeightedStrategy E2E', function () {
  this.timeout(300_000);

  let deploymentManager: Erc20InventoryLocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let deployedAddresses: Erc20InventoryDeployedAddresses;
  let strategyConfig: StrategyConfig[];

  const inventorySignerAddress = new ethers.Wallet(ANVIL_USER_PRIVATE_KEY)
    .address;

  before(async function () {
    deploymentManager = new Erc20InventoryLocalDeploymentManager(
      inventorySignerAddress,
    );
    const ctx = await deploymentManager.start();
    multiProvider = ctx.multiProvider;
    localProviders = ctx.providers;
    deployedAddresses = ctx.deployedAddresses;

    strategyConfig = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          anvil1: {
            weighted: { weight: 50n, tolerance: 5n },
            executionType: ExecutionType.MovableCollateral,
            bridge: deployedAddresses.bridgeRoute.anvil1,
            override: {
              anvil3: {
                executionType: ExecutionType.Inventory,
                externalBridge: ExternalBridgeType.LiFi,
              },
            },
          },
          anvil2: {
            weighted: { weight: 30n, tolerance: 5n },
            executionType: ExecutionType.MovableCollateral,
            bridge: deployedAddresses.bridgeRoute.anvil2,
            override: {
              anvil3: {
                executionType: ExecutionType.Inventory,
                externalBridge: ExternalBridgeType.LiFi,
              },
            },
          },
          anvil3: {
            weighted: { weight: 20n, tolerance: 5n },
            executionType: ExecutionType.Inventory,
            externalBridge: ExternalBridgeType.LiFi,
            override: {
              anvil1: {
                executionType: ExecutionType.Inventory,
                externalBridge: ExternalBridgeType.LiFi,
              },
              anvil2: {
                executionType: ExecutionType.Inventory,
                externalBridge: ExternalBridgeType.LiFi,
              },
            },
          },
        },
      },
    ];

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
      Reflect.set(provider, '_maxInternalBlockNumber', -1);
      Reflect.set(provider, '_internalBlockNumber', null);
    }
  });

  after(async function () {
    await deploymentManager.stop();
  });

  it('executes movableCollateral + inventory in the same cycle', async function () {
    const context = await TestRebalancer.builder(
      deploymentManager,
      multiProvider,
    )
      .withStrategy(strategyConfig)
      .withExecutionMode('execute')
      .withErc20InventoryConfig({
        inventorySignerKey: ANVIL_USER_PRIVATE_KEY,
        erc20DeployedAddresses: deployedAddresses,
      })
      .withBalances('WEIGHTED_IMBALANCED')
      .build();

    const event = await getFirstMonitorEvent(context.createMonitor(0));
    await context.orchestrator.executeCycle(event);

    const intents = await context.tracker.getActiveRebalanceIntents();
    expect(intents.length).to.equal(2);
    const destinations = intents.map((i) => i.destination);
    expect(destinations).to.include(DOMAIN_IDS.anvil2);
    expect(destinations).to.include(DOMAIN_IDS.anvil3);

    const actions = await context.tracker.getInProgressActions();
    const actionTypes = actions.map((a) => a.type);
    expect(actionTypes).to.include('rebalance_message');
    expect(actionTypes).to.include('inventory_deposit');
  });
});
