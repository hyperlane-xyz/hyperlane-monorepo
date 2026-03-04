import { expect } from 'chai';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import type { EMAFlowStrategy as EMAFlowStrategyConfig } from '../../config/types.js';
import type { RawBalances } from '../../interfaces/IStrategy.js';
import type { IActionTracker } from '../../tracking/IActionTracker.js';
import type { BridgeConfigWithOverride } from '../../utils/bridgeUtils.js';

import { EMAFlowStrategy } from './EMAFlowStrategy.js';
import type { FlowRecord } from './types.js';

const testLogger = pino({ level: 'silent' });

const CHAIN1 = 'chain1' as ChainName;
const CHAIN2 = 'chain2' as ChainName;

const BRIDGE1 = '0x1234567890123456789012345678901234567890' as Address;
const BRIDGE2 = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;

function createMockActionTracker(): IActionTracker {
  return {
    initialize: Sinon.stub().resolves(),
    syncTransfers: Sinon.stub().resolves(),
    syncRebalanceIntents: Sinon.stub().resolves(),
    syncRebalanceActions: Sinon.stub().resolves(),
    syncInventoryMovementActions: Sinon.stub().resolves({
      completed: 0,
      failed: 0,
    }),
    getTransfer: Sinon.stub().resolves(undefined),
    getInProgressTransfers: Sinon.stub().resolves([]),
    getTransfersByDestination: Sinon.stub().resolves([]),
    getRecentTransfers: Sinon.stub().resolves([]),
    getRebalanceIntent: Sinon.stub().resolves(undefined),
    getActiveRebalanceIntents: Sinon.stub().resolves([]),
    getRebalanceIntentsByDestination: Sinon.stub().resolves([]),
    getPartiallyFulfilledInventoryIntents: Sinon.stub().resolves([]),
    createRebalanceIntent: Sinon.stub().resolves({
      id: 'intent-1',
      status: 'not_started',
    }),
    completeRebalanceIntent: Sinon.stub().resolves(),
    cancelRebalanceIntent: Sinon.stub().resolves(),
    failRebalanceIntent: Sinon.stub().resolves(),
    getActionsByType: Sinon.stub().resolves([]),
    getActionsForIntent: Sinon.stub().resolves([]),
    getInflightInventoryMovements: Sinon.stub().resolves(0n),
    getRebalanceAction: Sinon.stub().resolves(undefined),
    getInProgressActions: Sinon.stub().resolves([]),
    createRebalanceAction: Sinon.stub().resolves({ id: 'action-1' }),
    completeRebalanceAction: Sinon.stub().resolves(),
    failRebalanceAction: Sinon.stub().resolves(),
    logStoreContents: Sinon.stub().resolves(),
  } as unknown as IActionTracker;
}

function createBridgeConfigs(): ChainMap<BridgeConfigWithOverride> {
  return {
    [CHAIN1]: {
      executionType: 'movableCollateral',
      bridge: BRIDGE1,
      bridgeMinAcceptedAmount: 0,
    },
    [CHAIN2]: {
      executionType: 'movableCollateral',
      bridge: BRIDGE2,
      bridgeMinAcceptedAmount: 0,
    },
  };
}

function createConfig(
  chain1Overrides: Partial<
    EMAFlowStrategyConfig['chains'][string]['emaFlow']
  > = {},
  chain2Overrides: Partial<
    EMAFlowStrategyConfig['chains'][string]['emaFlow']
  > = {},
): EMAFlowStrategyConfig['chains'] {
  return {
    [CHAIN1]: {
      bridge: BRIDGE1,
      emaFlow: {
        alpha: 0.5,
        windowSizeMs: 60_000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
        ...chain1Overrides,
      },
    },
    [CHAIN2]: {
      bridge: BRIDGE2,
      emaFlow: {
        alpha: 0.5,
        windowSizeMs: 60_000,
        minSamplesForSignal: 3,
        coldStartCycles: 2,
        ...chain2Overrides,
      },
    },
  };
}

function createStrategy(
  chain1Overrides: Partial<
    EMAFlowStrategyConfig['chains'][string]['emaFlow']
  > = {},
  chain2Overrides: Partial<
    EMAFlowStrategyConfig['chains'][string]['emaFlow']
  > = {},
): EMAFlowStrategy {
  return new EMAFlowStrategy(
    createConfig(chain1Overrides, chain2Overrides),
    testLogger,
    createBridgeConfigs(),
    createMockActionTracker(),
  );
}

function makeRecord(
  chain: ChainName,
  amount: bigint,
  timestamp = Date.now(),
): FlowRecord {
  return { chain, amount, timestamp };
}

describe('EMAFlowStrategy', () => {
  it('computes EMA accurately (alpha=0.5, netFlow=100, prevEma=0 => ema=50)', () => {
    const strategy = createStrategy({ alpha: 0.5, minSamplesForSignal: 1 });
    const flowHistory = new Map<ChainName, FlowRecord[]>([
      [CHAIN1, [makeRecord(CHAIN1, 100n)]],
    ]);
    const signals = strategy.computeFlowSignals(flowHistory);
    expect(signals).to.deep.equal([
      { chain: CHAIN1, magnitude: 50n, direction: 'surplus' },
    ]);
  });

  it('returns empty categorized balances during cold start cycles', () => {
    const strategy = createStrategy({
      coldStartCycles: 2,
      minSamplesForSignal: 1,
    });
    const balances: RawBalances = { [CHAIN1]: 0n, [CHAIN2]: 0n };
    const first = (strategy as any).getCategorizedBalances(balances);
    const second = (strategy as any).getCategorizedBalances(balances);
    expect(first).to.deep.equal({ surpluses: [], deficits: [] });
    expect(second).to.deep.equal({ surpluses: [], deficits: [] });
  });

  it('emits surplus signal for positive EMA', () => {
    const strategy = createStrategy({ minSamplesForSignal: 1, alpha: 0.5 });
    const flowHistory = new Map<ChainName, FlowRecord[]>([
      [CHAIN1, [makeRecord(CHAIN1, 40n)]],
    ]);
    const signals = strategy.computeFlowSignals(flowHistory);
    expect(signals).to.deep.equal([
      { chain: CHAIN1, magnitude: 20n, direction: 'surplus' },
    ]);
  });

  it('emits deficit signal for negative EMA', () => {
    const strategy = createStrategy({ minSamplesForSignal: 1, alpha: 1 });
    const flowHistory = new Map<ChainName, FlowRecord[]>([
      [CHAIN1, [makeRecord(CHAIN1, -75n)]],
    ]);
    const signals = strategy.computeFlowSignals(flowHistory);
    expect(signals).to.deep.equal([
      { chain: CHAIN1, magnitude: 75n, direction: 'deficit' },
    ]);
  });

  it('does not emit signal when record count is below minSamplesForSignal', () => {
    const strategy = createStrategy({ minSamplesForSignal: 3 });
    const flowHistory = new Map<ChainName, FlowRecord[]>([
      [CHAIN1, [makeRecord(CHAIN1, 10n), makeRecord(CHAIN1, 20n)]],
    ]);
    const signals = strategy.computeFlowSignals(flowHistory);
    expect(signals).to.deep.equal([]);
  });

  it('returns no signals for empty flow records', () => {
    const strategy = createStrategy({ minSamplesForSignal: 1 });
    const flowHistory = new Map<ChainName, FlowRecord[]>([
      [CHAIN1, []],
      [CHAIN2, []],
    ]);
    const signals = strategy.computeFlowSignals(flowHistory);
    expect(signals).to.deep.equal([]);
  });

  it('computes each chain independently in multi-chain input', () => {
    const strategy = createStrategy(
      { minSamplesForSignal: 1, alpha: 0.5 },
      { minSamplesForSignal: 1, alpha: 0.5 },
    );
    const flowHistory = new Map<ChainName, FlowRecord[]>([
      [CHAIN1, [makeRecord(CHAIN1, 100n)]],
      [CHAIN2, [makeRecord(CHAIN2, -80n)]],
    ]);
    const signals = strategy.computeFlowSignals(flowHistory);
    expect(signals).to.deep.equal([
      { chain: CHAIN1, magnitude: 50n, direction: 'surplus' },
      { chain: CHAIN2, magnitude: 40n, direction: 'deficit' },
    ]);
  });

  it('alpha=0 ignores new data and keeps previous EMA (stays zero)', () => {
    const strategy = createStrategy({ alpha: 0, minSamplesForSignal: 1 });
    const first = strategy.computeFlowSignals(
      new Map<ChainName, FlowRecord[]>([[CHAIN1, [makeRecord(CHAIN1, 500n)]]]),
    );
    const second = strategy.computeFlowSignals(
      new Map<ChainName, FlowRecord[]>([[CHAIN1, [makeRecord(CHAIN1, -900n)]]]),
    );
    expect(first).to.deep.equal([]);
    expect(second).to.deep.equal([]);
  });

  it('alpha=1 uses only latest net flow', () => {
    const strategy = createStrategy({ alpha: 1, minSamplesForSignal: 1 });
    const first = strategy.computeFlowSignals(
      new Map<ChainName, FlowRecord[]>([[CHAIN1, [makeRecord(CHAIN1, 33n)]]]),
    );
    const second = strategy.computeFlowSignals(
      new Map<ChainName, FlowRecord[]>([[CHAIN1, [makeRecord(CHAIN1, -21n)]]]),
    );
    expect(first).to.deep.equal([
      { chain: CHAIN1, magnitude: 33n, direction: 'surplus' },
    ]);
    expect(second).to.deep.equal([
      { chain: CHAIN1, magnitude: 21n, direction: 'deficit' },
    ]);
  });
});
