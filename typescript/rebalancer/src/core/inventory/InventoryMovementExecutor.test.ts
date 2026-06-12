import { expect } from 'chai';
import { pino } from 'pino';

import type { ChainName, MultiProvider, Token } from '@hyperlane-xyz/sdk';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ExternalBridgeType } from '../../config/types.js';
import type { InventoryRebalancerConfig } from '../InventoryRebalancer.js';
import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../../interfaces/IExternalBridge.js';
import type {
  CreateRebalanceActionParams,
  IActionTracker,
} from '../../tracking/IActionTracker.js';
import type { RebalanceIntent } from '../../tracking/types.js';
import { InventoryMovementExecutor } from './InventoryMovementExecutor.js';

const logger = pino({ level: 'silent' });

function token(): Token {
  return {
    addressOrDenom: '0x1111111111111111111111111111111111111111',
    collateralAddressOrDenom: '0x2222222222222222222222222222222222222222',
    decimals: 18,
    standard: TokenStandard.EvmHypCollateral,
  } as unknown as Token;
}

function quoteFrom(
  params: BridgeQuoteParams,
  overrides: Partial<BridgeQuote> = {},
): BridgeQuote {
  return {
    id: 'quote',
    tool: 'test',
    fromAmount: params.fromAmount ?? params.toAmount ?? 0n,
    toAmount: params.toAmount ?? params.fromAmount ?? 0n,
    toAmountMin: params.toAmount ?? params.fromAmount ?? 0n,
    executionDuration: 1,
    gasCosts: 0n,
    feeCosts: 0n,
    route: undefined,
    requestParams: params,
    ...overrides,
  };
}

type BridgeFake = IExternalBridge & {
  quoteCalls: BridgeQuoteParams[];
  executedQuotes: BridgeQuote[];
};

function bridgeWithQuotes(
  quote: (params: BridgeQuoteParams) => Promise<BridgeQuote>,
): BridgeFake {
  const quoteCalls: BridgeQuoteParams[] = [];
  const executedQuotes: BridgeQuote[] = [];

  return {
    externalBridgeId: 'test',
    logger,
    quoteCalls,
    executedQuotes,
    quote: async (params) => {
      quoteCalls.push(params);
      return quote(params);
    },
    execute: async (quoteToExecute): Promise<BridgeTransferResult> => {
      executedQuotes.push(quoteToExecute);
      return {
        txHash: '0xabc',
        fromChain: quoteToExecute.requestParams.fromChain,
        toChain: quoteToExecute.requestParams.toChain,
      };
    },
    getStatus: async (): Promise<BridgeTransferStatus> => ({
      status: 'pending',
    }),
  };
}

function actionTracker(
  createdActions: CreateRebalanceActionParams[],
): IActionTracker {
  return {
    createRebalanceAction: async (params: CreateRebalanceActionParams) => {
      createdActions.push(params);
      return {
        id: 'action',
        status: 'in_progress',
        createdAt: 1,
        updatedAt: 1,
        ...params,
      };
    },
  } as unknown as IActionTracker;
}

function executor(
  bridge: IExternalBridge,
  consumed: Map<ChainName, bigint>,
  createdActions: CreateRebalanceActionParams[],
): InventoryMovementExecutor {
  const config: InventoryRebalancerConfig = {
    inventorySigners: {
      [ProtocolType.Ethereum]: {
        address: '0x0000000000000000000000000000000000000001',
        key: '0xinventory',
      },
    },
    inventoryChains: [],
  };
  const multiProvider = {
    getChainId: (chain: ChainName) => (chain === arbitrum ? 42161 : 8453),
    getDomainId: (chain: ChainName) => (chain === arbitrum ? 42161 : 8453),
  } as unknown as MultiProvider;

  return new InventoryMovementExecutor(
    config,
    actionTracker(createdActions),
    () => consumed,
    multiProvider,
    () => bridge,
    () => '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    () => token(),
    () => ProtocolType.Ethereum,
    () => '0x0000000000000000000000000000000000000001',
    logger,
  );
}

const arbitrum = 'arbitrum' as ChainName;
const base = 'base' as ChainName;
const intent: RebalanceIntent = {
  id: 'intent',
  origin: 42161,
  destination: 8453,
  amount: 100n,
  status: 'in_progress',
  createdAt: 1,
  updatedAt: 1,
};

describe('InventoryMovementExecutor', () => {
  it('falls back from over-cap reverse quote to forward quote and books consumed inventory', async () => {
    const bridge = bridgeWithQuotes(async (params) => {
      if (params.toAmount !== undefined) {
        return quoteFrom(params, {
          fromAmount: 120n,
          toAmount: params.toAmount,
          toAmountMin: params.toAmount,
        });
      }

      return quoteFrom(params, {
        fromAmount: 100n,
        toAmount: 95n,
        toAmountMin: 90n,
      });
    });
    const consumed = new Map<ChainName, bigint>([[arbitrum, 7n]]);
    const createdActions: CreateRebalanceActionParams[] = [];

    const result = await executor(
      bridge,
      consumed,
      createdActions,
    ).executeInventoryMovement(
      arbitrum,
      base,
      95n,
      100n,
      'reverse',
      intent,
      ExternalBridgeType.LiFi,
    );

    expect(result).to.deep.equal({
      success: true,
      txHash: '0xabc',
      inputRequired: 100n,
      quotedOutput: 95n,
      quotedOutputMin: 90n,
      quoteModeUsed: 'forward',
    });
    expect(
      bridge.quoteCalls.map((params) => ({
        fromAmount: params.fromAmount,
        toAmount: params.toAmount,
      })),
    ).to.deep.equal([
      { fromAmount: undefined, toAmount: 95n },
      { fromAmount: 100n, toAmount: undefined },
    ]);
    expect(bridge.executedQuotes).to.have.length(1);
    expect(consumed.get(arbitrum)).to.equal(107n);
    expect(createdActions).to.deep.include({
      intentId: 'intent',
      origin: 42161,
      destination: 8453,
      amount: 100n,
      type: 'inventory_movement',
      txHash: '0xabc',
      externalBridgeId: ExternalBridgeType.LiFi,
    });
  });

  it('does not execute or consume inventory when forward quote exceeds planned capacity', async () => {
    const bridge = bridgeWithQuotes(async (params) =>
      quoteFrom(params, {
        fromAmount: 101n,
        toAmount: 95n,
        toAmountMin: 90n,
      }),
    );
    const consumed = new Map<ChainName, bigint>();
    const createdActions: CreateRebalanceActionParams[] = [];

    const result = await executor(
      bridge,
      consumed,
      createdActions,
    ).executeInventoryMovement(
      arbitrum,
      base,
      95n,
      100n,
      'forward',
      intent,
      ExternalBridgeType.LiFi,
    );

    expect(result).to.deep.equal({
      success: false,
      error: 'Bridge input 101 exceeded planned source capacity 100',
    });
    expect(bridge.executedQuotes).to.deep.equal([]);
    expect(consumed.get(arbitrum)).to.equal(undefined);
    expect(createdActions).to.deep.equal([]);
  });
});
