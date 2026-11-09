import { expect } from 'chai';
import { BigNumber, ethers, providers } from 'ethers';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { HyperlaneCore, MultiProvider, snapshot } from '@hyperlane-xyz/sdk';
import { assert, sleep } from '@hyperlane-xyz/utils';

import {
  PendingTransferMiddlewareType,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '../config/types.js';
import type { RebalanceAction } from '../tracking/types.js';
import type { ExplorerMessage } from '../utils/ExplorerClient.js';

import {
  ANVIL_TEST_PRIVATE_KEY,
  DOMAIN_IDS,
  type DeployedAddresses,
  TEST_CHAINS,
  type TestChain,
} from './fixtures/routes.js';
import { getAllCollateralBalances } from './harness/BridgeSetup.js';
import { type LocalDeploymentContext } from './harness/BaseLocalDeploymentManager.js';
import { Erc20LocalDeploymentManager } from './harness/Erc20LocalDeploymentManager.js';
import { resetSnapshotsAndRefreshProviders } from './harness/SnapshotHelper.js';
import { getFirstMonitorEvent } from './harness/TestHelpers.js';
import {
  TestRebalancer,
  type TestRebalancerContext,
} from './harness/TestRebalancer.js';
import { tryRelayMessage } from './harness/TransferHelper.js';

const USDC = 1_000_000n;
const REBALANCE_MESSAGE = 'rebalance_message';

// Re-reads the denylist on every Explorer query, so a rule written between
// cycles applies to the next one. Config files cannot set 0: the schema
// requires a positive interval.
const DENYLIST_REFRESH_INTERVAL_SECS = 0;
const POSITIVE_REFRESH_INTERVAL_SECS = 20;
const REFRESH_WAIT_MARGIN_MS = 1_000;

describe('RelayerDenylist middleware rebalance messages E2E', function () {
  this.timeout(300_000);

  let deploymentManager: Erc20LocalDeploymentManager;
  let multiProvider: MultiProvider;
  let localProviders: Map<string, providers.JsonRpcProvider>;
  let snapshotIds: Map<string, string>;
  let hyperlaneCore: HyperlaneCore;
  let deployedAddresses: DeployedAddresses;
  let weightedStrategyConfig: StrategyConfig[];
  let denylistDir: string;
  let denylistPath: string;

  before(async function () {
    deploymentManager = new Erc20LocalDeploymentManager();
    const ctx: LocalDeploymentContext<DeployedAddresses> =
      await deploymentManager.start();
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

    weightedStrategyConfig = [
      {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          anvil1: {
            weighted: { weight: 60n, tolerance: 5n },
            bridge: deployedAddresses.bridgeRoute1.anvil1,
          },
          anvil2: {
            weighted: { weight: 20n, tolerance: 5n },
            bridge: deployedAddresses.bridgeRoute1.anvil2,
          },
          anvil3: {
            weighted: { weight: 20n, tolerance: 5n },
            bridge: deployedAddresses.bridgeRoute1.anvil3,
          },
        },
      },
    ];

    snapshotIds = new Map();
    for (const [chain, provider] of localProviders) {
      snapshotIds.set(chain, await snapshot(provider));
    }
  });

  beforeEach(function () {
    denylistDir = mkdtempSync(join(tmpdir(), 'rebalancer-denylist-e2e-'));
    denylistPath = join(denylistDir, 'denylist.json');
    writeDenylist([]);
  });

  afterEach(async function () {
    rmSync(denylistDir, { recursive: true, force: true });
    await resetSnapshotsAndRefreshProviders({
      localProviders,
      multiProvider,
      snapshotIds,
    });
  });

  after(async function () {
    if (deploymentManager) {
      await deploymentManager.stop();
    }
  });

  function writeDenylist(messageIds: string[]): void {
    writeFileSync(
      denylistPath,
      JSON.stringify({
        rules: messageIds.map((messageId) => ({
          reason: 'CCTP delivered the funds out of band',
          addedBy: 'e2e',
          match: { messageId },
        })),
      }),
    );
  }

  function buildContext(
    balances: string | Record<string, BigNumber>,
    mockRebalanceActions: ExplorerMessage[] = [],
    refreshIntervalSecs = DENYLIST_REFRESH_INTERVAL_SECS,
  ): Promise<TestRebalancerContext> {
    const builder = TestRebalancer.builder(deploymentManager, multiProvider)
      .withStrategy(weightedStrategyConfig)
      .withBalances(balances)
      .withPendingTransferMiddlewares([
        {
          type: PendingTransferMiddlewareType.RelayerDenylist,
          url: pathToFileURL(denylistPath).href,
          refreshIntervalSecs,
        },
      ])
      .withExecutionMode('execute');
    for (const message of mockRebalanceActions) {
      builder.withMockRebalanceAction(message);
    }
    return builder.build();
  }

  async function runCycle(context: TestRebalancerContext): Promise<void> {
    const event = await getFirstMonitorEvent(context.createMonitor(0));
    await context.orchestrator.executeCycle(event);
  }

  function getBalances(): Promise<Record<string, BigNumber>> {
    return getAllCollateralBalances(
      localProviders,
      TEST_CHAINS,
      deployedAddresses.monitoredRoute,
      deployedAddresses.tokens,
    );
  }

  function expectBalances(
    balances: Record<string, BigNumber>,
    expected: Record<TestChain, bigint>,
  ): void {
    for (const chain of TEST_CHAINS) {
      expect(balances[chain].toBigInt(), `${chain} collateral`).to.equal(
        expected[chain],
      );
    }
  }

  // Simulates CCTP minting the bridged funds to the destination router while
  // the companion Hyperlane message stays undeliverable.
  async function deliverOutOfBand(
    chain: TestChain,
    amount: bigint,
  ): Promise<void> {
    const provider = localProviders.get(chain);
    assert(provider, `Missing provider for chain ${chain}`);
    const token = ERC20__factory.connect(
      deployedAddresses.tokens[chain],
      new ethers.Wallet(ANVIL_TEST_PRIVATE_KEY, provider),
    );
    const tx = await token.transfer(
      deployedAddresses.monitoredRoute[chain],
      amount,
    );
    await tx.wait();
  }

  function findAction(
    actions: RebalanceAction[],
    destination: TestChain,
  ): RebalanceAction {
    const action = actions.find(
      (a) => a.destination === DOMAIN_IDS[destination],
    );
    assert(action, `Missing rebalance action to ${destination}`);
    return action;
  }

  function getMessageId(action: RebalanceAction): string {
    assert(action.messageId, `Missing message id on action ${action.id}`);
    return action.messageId;
  }

  // Cycle 1 moves 1000 USDC anvil1 -> anvil3; CCTP then delivers it out of
  // band, leaving the routers balanced at 6000/2000/2000.
  async function rebalanceAndDeliverOutOfBand(
    context: TestRebalancerContext,
  ): Promise<RebalanceAction> {
    await runCycle(context);

    const intents = await context.tracker.getActiveRebalanceIntents();
    expect(intents.length).to.equal(1);
    const actions = await context.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(actions.length).to.equal(1);
    const [action] = actions;
    expect(action.intentId).to.equal(intents[0].id);
    expect(action.origin).to.equal(DOMAIN_IDS.anvil1);
    expect(action.destination).to.equal(DOMAIN_IDS.anvil3);
    expect(action.amount).to.equal(1000n * USDC);
    expect(action.status).to.equal('in_progress');
    expectBalances(await getBalances(), {
      anvil1: 6000n * USDC,
      anvil2: 2000n * USDC,
      anvil3: 1000n * USDC,
    });

    await deliverOutOfBand('anvil3', action.amount);
    expectBalances(await getBalances(), {
      anvil1: 6000n * USDC,
      anvil2: 2000n * USDC,
      anvil3: 2000n * USDC,
    });

    return action;
  }

  // Seen as still in flight, the out-of-band 1000 USDC inflates the total to
  // 11000, so anvil3 looks 800 over its 2200 target.
  async function expectDoubleCounted(
    context: TestRebalancerContext,
    action: RebalanceAction,
  ): Promise<void> {
    const actions = await context.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(actions.length).to.equal(3);
    const toAnvil1 = findAction(actions, 'anvil1');
    expect(toAnvil1.origin).to.equal(DOMAIN_IDS.anvil3);
    expect(toAnvil1.amount).to.equal(600n * USDC);
    const toAnvil2 = findAction(actions, 'anvil2');
    expect(toAnvil2.origin).to.equal(DOMAIN_IDS.anvil3);
    expect(toAnvil2.amount).to.equal(200n * USDC);

    const intents = await context.tracker.getActiveRebalanceIntents();
    expect(intents.map((i) => i.id)).to.have.members([
      action.intentId,
      toAnvil1.intentId,
      toAnvil2.intentId,
    ]);
  }

  async function getIndexedMessage(
    context: TestRebalancerContext,
    messageId: string,
  ): Promise<ExplorerMessage> {
    await context.forkIndexer.sync(await context.getConfirmedBlockTags());
    const message = context.forkIndexer
      .getRebalanceActions()
      .find((m) => m.msg_id === messageId);
    assert(message, `Fork indexer did not index message ${messageId}`);
    return message;
  }

  async function expectStillInProgress(
    context: TestRebalancerContext,
    action: RebalanceAction,
  ): Promise<void> {
    const storedAction = await context.tracker.getRebalanceAction(action.id);
    expect(storedAction?.status).to.equal('in_progress');
    const storedIntent = await context.tracker.getRebalanceIntent(
      action.intentId,
    );
    expect(storedIntent?.status).to.equal('in_progress');
  }

  it('double counts an out-of-band delivered rebalance that is not denylisted', async function () {
    const context = await buildContext('WEIGHTED_IMBALANCED');
    const action = await rebalanceAndDeliverOutOfBand(context);

    await runCycle(context);

    await expectDoubleCounted(context, action);
    await expectStillInProgress(context, action);
  });

  it('stops counting a rebalance once its message is denylisted', async function () {
    const context = await buildContext('WEIGHTED_IMBALANCED');
    const action = await rebalanceAndDeliverOutOfBand(context);

    writeDenylist([getMessageId(action)]);
    await runCycle(context);

    expect(await context.tracker.getActiveRebalanceIntents()).to.be.empty;
    const actions = await context.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(actions.length).to.equal(1);
    expect(actions[0].id).to.equal(action.id);
    await expectStillInProgress(context, action);
  });

  it('stops counting a denylisted rebalance once the refresh interval passes', async function () {
    const context = await buildContext(
      'WEIGHTED_IMBALANCED',
      [],
      POSITIVE_REFRESH_INTERVAL_SECS,
    );
    const action = await rebalanceAndDeliverOutOfBand(context);

    writeDenylist([getMessageId(action)]);
    const ruleWrittenAt = Date.now();
    await context.tracker.syncRebalanceActions(
      await context.getConfirmedBlockTags(),
    );
    expect(
      (await context.tracker.getActiveRebalanceIntents()).map((i) => i.id),
    ).to.deep.equal([action.intentId]);

    // The rule was not loaded above, so the last load predates it.
    await sleep(
      ruleWrittenAt +
        POSITIVE_REFRESH_INTERVAL_SECS * 1_000 +
        REFRESH_WAIT_MARGIN_MS -
        Date.now(),
    );
    await runCycle(context);

    expect(await context.tracker.getActiveRebalanceIntents()).to.be.empty;
    const actions = await context.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(actions.length).to.equal(1);
    expect(actions[0].id).to.equal(action.id);
    await expectStillInProgress(context, action);
  });

  it('counts the rebalance again once its deny rule is removed', async function () {
    const context = await buildContext('WEIGHTED_IMBALANCED');
    const action = await rebalanceAndDeliverOutOfBand(context);

    writeDenylist([getMessageId(action)]);
    await runCycle(context);

    expect(await context.tracker.getActiveRebalanceIntents()).to.be.empty;
    expect(
      (await context.tracker.getActionsByType(REBALANCE_MESSAGE)).length,
    ).to.equal(1);

    writeDenylist([]);
    await runCycle(context);

    await expectDoubleCounted(context, action);
    await expectStillInProgress(context, action);
  });

  it('recovers and counts a non-denylisted rebalance after a restart', async function () {
    const context = await buildContext('WEIGHTED_IMBALANCED');
    const action = await rebalanceAndDeliverOutOfBand(context);
    const messageId = getMessageId(action);
    const message = await getIndexedMessage(context, messageId);

    const restarted = await buildContext(await getBalances(), [message]);

    const recovered =
      await restarted.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(recovered.length).to.equal(1);
    expect(recovered[0].id).to.equal(messageId);
    expect(recovered[0].status).to.equal('in_progress');
    expect(
      (await restarted.tracker.getActiveRebalanceIntents()).map((i) => i.id),
    ).to.deep.equal([recovered[0].intentId]);

    await runCycle(restarted);

    await expectDoubleCounted(restarted, recovered[0]);
  });

  it('does not recover a denylisted rebalance after a restart', async function () {
    const context = await buildContext('WEIGHTED_IMBALANCED');
    const action = await rebalanceAndDeliverOutOfBand(context);
    const messageId = getMessageId(action);
    const message = await getIndexedMessage(context, messageId);

    writeDenylist([messageId]);
    const restarted = await buildContext(await getBalances(), [message]);

    expect(await restarted.tracker.getActionsByType(REBALANCE_MESSAGE)).to.be
      .empty;
    expect(await restarted.tracker.getActiveRebalanceIntents()).to.be.empty;

    await runCycle(restarted);

    expect(await restarted.tracker.getActionsByType(REBALANCE_MESSAGE)).to.be
      .empty;
    expect(await restarted.tracker.getActiveRebalanceIntents()).to.be.empty;
  });

  it('completes a denylisted rebalance whose message is delivered', async function () {
    const context = await buildContext('WEIGHTED_IMBALANCED');
    await runCycle(context);

    const actions = await context.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(actions.length).to.equal(1);
    const [action] = actions;
    const messageId = getMessageId(action);
    writeDenylist([messageId]);
    await context.tracker.syncRebalanceActions(
      await context.getConfirmedBlockTags(),
    );
    expect(await context.tracker.getActiveRebalanceIntents()).to.be.empty;

    const originProvider = localProviders.get('anvil1');
    assert(originProvider, 'Missing provider for chain anvil1');
    assert(action.txHash, `Missing tx hash on action ${action.id}`);
    const relayResult = await tryRelayMessage(multiProvider, hyperlaneCore, {
      dispatchTx: await originProvider.getTransactionReceipt(action.txHash),
      messageId,
      origin: 'anvil1',
      destination: 'anvil3',
    });
    expect(relayResult.success, `Relay failed: ${relayResult.error}`).to.be
      .true;

    await context.tracker.syncRebalanceActions(
      await context.getConfirmedBlockTags(),
    );

    const storedAction = await context.tracker.getRebalanceAction(action.id);
    expect(storedAction?.status).to.equal('complete');
    const storedIntent = await context.tracker.getRebalanceIntent(
      action.intentId,
    );
    expect(storedIntent?.status).to.equal('complete');
    expect(await context.tracker.getInProgressActions()).to.be.empty;
    expect(await context.tracker.getActiveRebalanceIntents()).to.be.empty;
    expectBalances(await getBalances(), {
      anvil1: 6000n * USDC,
      anvil2: 2000n * USDC,
      anvil3: 2000n * USDC,
    });
  });

  it('keeps counting the rebalance that is not denylisted', async function () {
    const context = await buildContext({
      anvil1: BigNumber.from(8000n * USDC),
      anvil2: BigNumber.from(1000n * USDC),
      anvil3: BigNumber.from(1000n * USDC),
    });
    await runCycle(context);

    const actions = await context.tracker.getActionsByType(REBALANCE_MESSAGE);
    expect(actions.length).to.equal(2);
    const toAnvil2 = findAction(actions, 'anvil2');
    const toAnvil3 = findAction(actions, 'anvil3');
    expect(toAnvil2.amount).to.equal(1000n * USDC);
    expect(toAnvil3.amount).to.equal(1000n * USDC);
    expect((await context.tracker.getActiveRebalanceIntents()).length).to.equal(
      2,
    );

    await deliverOutOfBand('anvil3', toAnvil3.amount);
    writeDenylist([getMessageId(toAnvil3)]);
    expectBalances(await getBalances(), {
      anvil1: 6000n * USDC,
      anvil2: 1000n * USDC,
      anvil3: 2000n * USDC,
    });

    await runCycle(context);

    const intents = await context.tracker.getActiveRebalanceIntents();
    expect(intents.map((i) => i.id)).to.deep.equal([toAnvil2.intentId]);
    expect(
      (await context.tracker.getActionsByType(REBALANCE_MESSAGE)).length,
    ).to.equal(2);
    await expectStillInProgress(context, toAnvil2);
    await expectStillInProgress(context, toAnvil3);
  });
});
