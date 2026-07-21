import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { WarpCore } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ExternalBridgeType } from '../config/types.js';
import type { InventoryRoute } from '../interfaces/IStrategy.js';
import type { RebalanceIntent } from '../tracking/types.js';

import {
  ManualInventoryRebalanceRunner,
  type ManualInventoryActionTracker,
  type ManualInventoryRebalancer,
  type ManualInventoryRunnerClock,
} from './ManualInventoryRebalanceRunner.js';

const logger = pino({ level: 'silent' });
chai.use(chaiAsPromised);
const route: InventoryRoute = {
  origin: 'ethereum',
  destination: 'arbitrum',
  amount: 100n,
  executionType: 'inventory',
  externalBridge: ExternalBridgeType.LiFi,
};

describe('ManualInventoryRebalanceRunner', () => {
  let now: number;
  let clock: ManualInventoryRunnerClock;
  let sleepStub: Sinon.SinonStub<[number], Promise<void>>;
  let actionTracker: ManualInventoryActionTracker;
  let trackerStubs: {
    [Method in keyof ManualInventoryActionTracker]: Sinon.SinonStub;
  };
  let inventoryRebalancer: ManualInventoryRebalancer;
  let rebalance: Sinon.SinonStub;
  let intentStatus: RebalanceIntent['status'];
  let getBalance: Sinon.SinonStub;

  beforeEach(() => {
    now = 0;
    sleepStub = Sinon.stub<[number], Promise<void>>().callsFake(
      async (delayMs: number) => {
        now += delayMs;
      },
    );
    clock = {
      now: () => now,
      sleep: sleepStub,
    };
    intentStatus = 'in_progress';
    trackerStubs = {
      cancelRebalanceIntent: Sinon.stub().resolves(),
      getActionsForIntent: Sinon.stub().resolves([
        {
          type: 'inventory_deposit',
          status: 'complete',
          amount: 100n,
        },
      ]),
      getActiveRebalanceIntents: Sinon.stub().resolves([]),
      getPartiallyFulfilledInventoryIntents: Sinon.stub().resolves([]),
      getRebalanceIntent: Sinon.stub().callsFake(async () => ({
        id: 'intent-1',
        status: intentStatus,
        amount: 100n,
      })),
      logStoreContents: Sinon.stub().resolves(),
      syncInventoryMovementActions: Sinon.stub().resolves({
        completed: 0,
        failed: 0,
      }),
      syncRebalanceActions: Sinon.stub().resolves(),
      syncRebalanceIntents: Sinon.stub().resolves(),
    };
    actionTracker = trackerStubs;
    rebalance = Sinon.stub().resolves([
      { route, success: true, intentId: 'intent-1' },
    ]);
    inventoryRebalancer = {
      rebalancerType: 'inventory',
      rebalance,
      setInventoryBalances: Sinon.stub(),
    };
    getBalance = Sinon.stub().resolves(100n);
  });

  afterEach(() => Sinon.restore());

  function createRunner(): ManualInventoryRebalanceRunner {
    return new ManualInventoryRebalanceRunner({
      actionTracker,
      clock,
      externalBridgeRegistry: {},
      inventoryConfig: {
        chains: ['ethereum', 'arbitrum'],
        inventoryAddresses: {
          [ProtocolType.Ethereum]: '0x0000000000000000000000000000000000000001',
        },
      },
      inventoryRebalancer,
      logger,
      warpCore: {
        tokens: ['ethereum', 'arbitrum'].map((chainName) => ({
          chainName,
          protocol: ProtocolType.Ethereum,
          getAdapter: () => ({ getBalance }),
        })),
        multiProvider: {},
      } as unknown as WarpCore,
    });
  }

  it('fails fast when the first dispatch returns no intent', async () => {
    rebalance.resolves([]);

    await expect(createRunner().run(route, 60_000)).to.be.rejectedWith(
      'did not create an intent',
    );
    expect(sleepStub.called).to.be.false;
  });

  it('continues after a later empty result', async () => {
    rebalance
      .onFirstCall()
      .resolves([{ route, success: true, intentId: 'intent-1' }]);
    rebalance.onSecondCall().callsFake(async () => {
      intentStatus = 'complete';
      return [];
    });

    await createRunner().run(route, 60_000);

    expect(rebalance.secondCall.args[0]).to.deep.equal([]);
    expect(sleepStub.calledOnceWithExactly(15_000)).to.be.true;
  });

  it('warns and continues after a later failed result', async () => {
    const warning = Sinon.spy(logger, 'warn');
    rebalance
      .onFirstCall()
      .resolves([{ route, success: true, intentId: 'intent-1' }]);
    rebalance.onSecondCall().callsFake(async () => {
      intentStatus = 'complete';
      return [
        {
          route,
          success: false,
          intentId: 'intent-1',
          error: 'retryable failure',
        },
      ];
    });

    await createRunner().run(route, 60_000);

    expect(
      warning.calledWithMatch(
        Sinon.match.has('error', 'retryable failure'),
        'Manual inventory rebalance cycle failed; continuing to poll',
      ),
    ).to.be.true;
  });

  it('caps sleep at the deadline and does not cancel on timeout', async () => {
    await expect(createRunner().run(route, 20_000)).to.be.rejectedWith(
      'timed out',
    );

    expect(sleepStub.args).to.deep.equal([[15_000], [5_000]]);
    expect(trackerStubs.cancelRebalanceIntent.called).to.be.false;
    expect(trackerStubs.logStoreContents.calledOnce).to.be.true;
  });

  it('fails before dispatch when an inventory balance read fails', async () => {
    getBalance.rejects(new Error('RPC unavailable'));

    await expect(createRunner().run(route, 60_000)).to.be.rejectedWith(
      'RPC unavailable',
    );
    expect(rebalance.called).to.be.false;
  });
});
