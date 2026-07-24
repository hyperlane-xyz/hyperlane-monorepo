import { expect } from 'chai';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ExternalBridgeType } from '../config/types.js';
import type {
  BridgeQuote,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import {
  getExternalBridgeUsage,
  parseExternalBridgeArgs,
  runExternalBridgeCommand,
  waitForBridgeCompletion,
  type ExternalBridgeScriptOptions,
  type ResolvedExternalBridgeContext,
} from './externalBridgeRunner.js';

const testLogger = pino({ level: 'silent' });

class FakeBridge implements IExternalBridge {
  readonly externalBridgeId = 'fake';
  readonly logger = testLogger;

  quoteResult: BridgeQuote = {
    id: 'quote-1',
    tool: 'fake-tool',
    fromAmount: 5_000_000n,
    toAmount: 4_900_000n,
    toAmountMin: 4_800_000n,
    executionDuration: 120,
    gasCosts: 11n,
    feeCosts: 22n,
    route: { id: 'route-1' },
    requestParams: {
      fromChain: 1,
      toChain: 747474,
      fromToken: '0xfrom',
      toToken: '0xto',
      fromAmount: 5_000_000n,
      fromAddress: '0xsource',
      toAddress: '0xdest',
    },
  };

  executeResult: BridgeTransferResult = {
    txHash: '0xsource-tx',
    fromChain: 1,
    toChain: 747474,
  };

  statuses: BridgeTransferStatus[] = [{ status: 'pending', substatus: 'P1' }];
  quoteCalls = 0;
  executeCalls = 0;
  getStatusCalls = 0;

  async quote(): Promise<BridgeQuote> {
    this.quoteCalls += 1;
    return this.quoteResult;
  }

  async execute(): Promise<BridgeTransferResult> {
    this.executeCalls += 1;
    return this.executeResult;
  }

  async getStatus(): Promise<BridgeTransferStatus> {
    const next = this.statuses[
      Math.min(this.getStatusCalls, Math.max(this.statuses.length - 1, 0))
    ] ?? { status: 'not_found' };
    this.getStatusCalls += 1;
    return next;
  }
}

function createContext(bridge: IExternalBridge): ResolvedExternalBridgeContext {
  return {
    bridgeType: ExternalBridgeType.Katana,
    bridge,
    origin: 'ethereum',
    destination: 'katana',
    fromChainId: 1,
    toChainId: 747474,
    originToken: {
      chainName: 'ethereum',
      decimals: 6,
    } as any,
    destinationToken: {
      chainName: 'katana',
      decimals: 6,
    } as any,
    fromTokenAddress: '0xfrom',
    toTokenAddress: '0xto',
    fromAddress: '0xsource',
    toAddress: '0xdest',
    amountLocal: 5_000_000n,
    privateKeys: {
      [ProtocolType.Ethereum]: 'test-private-key',
    },
  };
}

function createOptions(
  overrides?: Partial<ExternalBridgeScriptOptions>,
): ExternalBridgeScriptOptions {
  return {
    configFile: '/tmp/test.yaml',
    bridge: ExternalBridgeType.Katana,
    origin: 'ethereum',
    destination: 'katana',
    amount: '5',
    mode: 'run',
    timeoutMs: 10_000,
    pollIntervalMs: 1,
    json: false,
    ...overrides,
  };
}

describe('externalBridgeRunner', () => {
  it('parses quote args', () => {
    const parsed = parseExternalBridgeArgs([
      '--config',
      '/tmp/cfg.yaml',
      '--bridge',
      'katana',
      '--origin',
      'ethereum',
      '--destination',
      'katana',
      '--mode',
      'quote',
      '--amount',
      '5',
      '--json',
    ]);

    expect(parsed).to.deep.equal({
      configFile: '/tmp/cfg.yaml',
      bridge: ExternalBridgeType.Katana,
      origin: 'ethereum',
      destination: 'katana',
      amount: '5',
      recipient: undefined,
      txHash: undefined,
      mode: 'quote',
      slippage: undefined,
      timeoutMs: 900_000,
      pollIntervalMs: 5_000,
      json: true,
    });
  });

  it('throws usage on help', () => {
    expect(() => parseExternalBridgeArgs(['--help'])).to.throw(
      getExternalBridgeUsage(),
    );
  });

  it('waits until complete', async () => {
    const bridge = new FakeBridge();
    bridge.statuses = [
      { status: 'pending', substatus: 'P1' },
      { status: 'pending', substatus: 'P2' },
      {
        status: 'complete',
        receivingTxHash: '0xdest',
        receivedAmount: 4_800_000n,
      },
    ];
    const seen: BridgeTransferStatus[] = [];

    const result = await waitForBridgeCompletion({
      bridge,
      txHash: '0xsource-tx',
      fromChain: 1,
      toChain: 747474,
      timeoutMs: 100,
      pollIntervalMs: 1,
      logger: testLogger,
      sleep: async () => {},
      onStatusChange: (status) => seen.push(status),
    });

    expect(result.status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdest',
      receivedAmount: 4_800_000n,
    });
    expect(seen).to.deep.equal(bridge.statuses);
  });

  it('runs quote mode without executing', async () => {
    const bridge = new FakeBridge();

    const result = await runExternalBridgeCommand(
      createContext(bridge),
      createOptions({ mode: 'quote' }),
      testLogger,
    );

    expect(result.mode).to.equal('quote');
    expect(bridge.quoteCalls).to.equal(1);
    expect(bridge.executeCalls).to.equal(0);
  });

  it('runs execute mode without waiting', async () => {
    const bridge = new FakeBridge();

    const result = await runExternalBridgeCommand(
      createContext(bridge),
      createOptions({ mode: 'execute' }),
      testLogger,
    );

    expect(result.mode).to.equal('execute');
    expect(bridge.quoteCalls).to.equal(1);
    expect(bridge.executeCalls).to.equal(1);
    expect(bridge.getStatusCalls).to.equal(0);
  });

  it('runs full quote-execute-wait flow', async () => {
    const bridge = new FakeBridge();
    bridge.statuses = [
      { status: 'pending', substatus: 'INDEXING' },
      {
        status: 'complete',
        receivingTxHash: '0xdest',
        receivedAmount: 4_900_000n,
      },
    ];

    const result = await runExternalBridgeCommand(
      createContext(bridge),
      createOptions({ mode: 'run', pollIntervalMs: 1 }),
      testLogger,
    );

    expect(result.mode).to.equal('run');
    if (result.mode !== 'run') throw new Error('Expected run result');
    expect(result.mode).to.equal('run');
    expect(bridge.quoteCalls).to.equal(1);
    expect(bridge.executeCalls).to.equal(1);
    expect(bridge.getStatusCalls).to.equal(2);
    expect(result.finalStatus).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdest',
      receivedAmount: 4_900_000n,
    });
  });

  it('waits on an existing tx hash without quoting', async () => {
    const bridge = new FakeBridge();
    bridge.statuses = [
      {
        status: 'complete',
        receivingTxHash: '0xdest',
        receivedAmount: 4_800_000n,
      },
    ];

    const result = await runExternalBridgeCommand(
      createContext(bridge),
      createOptions({ mode: 'wait', txHash: '0xexisting', amount: undefined }),
      testLogger,
    );

    expect(result.mode).to.equal('wait');
    if (result.mode !== 'wait') throw new Error('Expected wait result');
    expect(result.bridge).to.equal(ExternalBridgeType.Katana);
    expect(result.origin).to.equal('ethereum');
    expect(result.destination).to.equal('katana');
    expect(result.txHash).to.equal('0xexisting');
    expect(result.elapsedMs).to.be.greaterThanOrEqual(0);
    expect(result.status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdest',
      receivedAmount: 4_800_000n,
    });
    expect(bridge.quoteCalls).to.equal(0);
    expect(bridge.executeCalls).to.equal(0);
    expect(bridge.getStatusCalls).to.equal(1);
  });
});
