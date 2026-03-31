import Sinon, { type SinonStub } from 'sinon';

import type { BridgeQuote } from '../interfaces/IExternalBridge.js';
import type {
  MesonPriceResponse,
  MesonEncodeResponse,
  MesonSwapResponse,
  MesonStatusResponse,
} from '../bridges/mesonUtils.js';

export function createMesonPriceResponse(
  overrides?: Partial<MesonPriceResponse['result']>,
): MesonPriceResponse {
  return {
    result: {
      serviceFee: '0',
      lpFee: '0.01',
      totalFee: '0.01',
      ...overrides,
    },
  };
}

export function createMesonEncodeResponse(
  overrides?: Partial<MesonEncodeResponse['result']>,
): MesonEncodeResponse {
  return {
    result: {
      encoded:
        '0x010000989680d8abcdef1234567890abcdef1234567890abcdef1234567890ab',
      fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      recipient: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      initiator: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      fee: { serviceFee: '0', lpFee: '0.01', totalFee: '0.01' },
      signingRequest: {
        message: '0x19457468657265756d205369676e6564204d657373616765',
        hash: '0x230ca80a1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      },
      ...overrides,
    },
  };
}

export function createMesonSwapResponse(
  overrides?: Partial<MesonSwapResponse['result']>,
): MesonSwapResponse {
  return {
    result: {
      swapId:
        '0x03ae219d1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      ...overrides,
    },
  };
}

export function createMesonStatusResponse(
  status: 'BONDED' | 'RELEASED' | 'CANCELLED',
  overrides?: Partial<MesonStatusResponse['result']>,
): MesonStatusResponse {
  const baseResult = {
    _id: 'swap-123',
    encoded:
      '0x010000989680d8abcdef1234567890abcdef1234567890abcdef1234567890ab',
    status,
    fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    recipient: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    expireTs: Math.floor(Date.now() / 1000) + 3600,
    fromChain: 'eth',
    toChain: 'tron',
    inChain: '1',
    outChain: '728126428',
    hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  };

  const statusSpecificResult =
    status === 'RELEASED'
      ? {
          ...baseResult,
          outHash:
            '0x2222222222222222222222222222222222222222222222222222222222222222',
          amount: '9993000',
        }
      : baseResult;

  return {
    result: {
      ...statusSpecificResult,
      ...overrides,
    },
  };
}

export function createMockMesonBridgeQuote(
  overrides?: Partial<BridgeQuote<MesonPriceResponse>>,
): BridgeQuote<MesonPriceResponse> {
  const fromChain = overrides?.requestParams?.fromChain ?? 1;
  const toChain = overrides?.requestParams?.toChain ?? 728126428;
  const fromAmount = overrides?.fromAmount ?? 10_000_000n;
  const toAmount = overrides?.toAmount ?? 9_990_000n;
  const toAmountMin = overrides?.toAmountMin ?? 9_990_000n;

  return {
    id: 'meson-quote-123',
    tool: 'meson',
    fromAmount,
    toAmount,
    toAmountMin,
    executionDuration: 300,
    gasCosts: 0n,
    feeCosts: 10_000n,
    route: createMesonPriceResponse(),
    requestParams: {
      fromChain,
      toChain,
      fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      fromAmount,
    },
    ...overrides,
  };
}

export function createMesonFetchStub(
  responses?: Array<{ ok: boolean; status: number; body: unknown }>,
): SinonStub {
  const stub = Sinon.stub(globalThis, 'fetch');
  const defaultResponses = responses ?? [
    { ok: true, status: 200, body: createMesonPriceResponse() },
  ];

  defaultResponses.forEach((r, i) => {
    stub.onCall(i).resolves({
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response);
  });

  return stub;
}
