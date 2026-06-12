import { expect } from 'chai';
import { pino } from 'pino';

import type { ChainName, MultiProvider, Token } from '@hyperlane-xyz/sdk';
import { TokenStandard } from '@hyperlane-xyz/sdk';

import { ExternalBridgeType } from '../../config/types.js';
import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../../interfaces/IExternalBridge.js';
import { BridgeCapacityEstimator } from './BridgeCapacityEstimator.js';

const logger = pino({ level: 'silent' });

function quoteFrom(
  params: BridgeQuoteParams,
  overrides: Partial<BridgeQuote> = {},
): BridgeQuote {
  return {
    id: 'quote',
    tool: 'test',
    fromAmount: params.fromAmount ?? 0n,
    toAmount: params.fromAmount ?? 0n,
    toAmountMin: params.fromAmount ?? 0n,
    executionDuration: 1,
    gasCosts: 0n,
    feeCosts: 0n,
    route: undefined,
    requestParams: params,
    ...overrides,
  };
}

function token(standard: TokenStandard): Token {
  return {
    addressOrDenom: '0x1111111111111111111111111111111111111111',
    collateralAddressOrDenom: '0x2222222222222222222222222222222222222222',
    decimals: 18,
    standard,
  } as unknown as Token;
}

function bridgeWithQuote(
  quote: (params: BridgeQuoteParams) => Promise<BridgeQuote>,
): IExternalBridge {
  return {
    externalBridgeId: 'test',
    logger,
    quote,
    execute: async (): Promise<BridgeTransferResult> => ({
      txHash: '0x0',
      fromChain: 1,
      toChain: 2,
    }),
    getStatus: async (): Promise<BridgeTransferStatus> => ({
      status: 'pending',
    }),
  };
}

describe('BridgeCapacityEstimator', () => {
  const arbitrum = 'arbitrum' as ChainName;
  const base = 'base' as ChainName;
  const multiProvider = {
    getChainId: (chain: ChainName) => (chain === arbitrum ? 42161 : 8453),
  } as unknown as MultiProvider;

  it('rejects native bridge capacity when gas exceeds threshold', async () => {
    const quoteCalls: BridgeQuoteParams[] = [];
    const estimator = new BridgeCapacityEstimator(
      multiProvider,
      () =>
        bridgeWithQuote(async (params) => {
          quoteCalls.push(params);
          return quoteFrom(params, { gasCosts: 6n, toAmountMin: 100n });
        }),
      () => '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      () => token(TokenStandard.EvmHypNative),
      () => '0x0000000000000000000000000000000000000001',
      logger,
    );

    const capacity = await estimator.calculateBridgeCapacity(
      arbitrum,
      base,
      1000n,
      ExternalBridgeType.LiFi,
    );

    expect(capacity).to.deep.equal({
      maxSourceInput: 0n,
      maxTargetOutput: 0n,
    });
    expect(quoteCalls).to.have.length(1);
  });

  it('subtracts estimated gas and requotes viable native capacity', async () => {
    const quoteCalls: BridgeQuoteParams[] = [];
    const estimator = new BridgeCapacityEstimator(
      multiProvider,
      () =>
        bridgeWithQuote(async (params) => {
          quoteCalls.push(params);
          return quoteFrom(params, {
            gasCosts: 4n,
            toAmountMin: params.fromAmount === 920n ? 900n : 1000n,
          });
        }),
      () => '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      () => token(TokenStandard.EvmHypNative),
      () => '0x0000000000000000000000000000000000000001',
      logger,
    );

    const capacity = await estimator.calculateBridgeCapacity(
      arbitrum,
      base,
      1000n,
      ExternalBridgeType.LiFi,
    );

    expect(capacity).to.deep.equal({
      maxSourceInput: 920n,
      maxTargetOutput: 900n,
    });
    expect(quoteCalls.map((params) => params.fromAmount)).to.deep.equal([
      1000n,
      920n,
    ]);
  });

  it('returns zero capacity when bridge quote throws', async () => {
    const estimator = new BridgeCapacityEstimator(
      multiProvider,
      () =>
        bridgeWithQuote(async () => {
          throw new Error('quote unavailable');
        }),
      () => '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      () => token(TokenStandard.EvmHypCollateral),
      () => '0x0000000000000000000000000000000000000001',
      logger,
    );

    const capacity = await estimator.calculateBridgeCapacity(
      arbitrum,
      base,
      1000n,
      ExternalBridgeType.LiFi,
    );

    expect(capacity).to.deep.equal({
      maxSourceInput: 0n,
      maxTargetOutput: 0n,
    });
  });
});
