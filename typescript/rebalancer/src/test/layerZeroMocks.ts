import type {
  BridgeQuote,
  BridgeQuoteParams,
} from '../interfaces/IExternalBridge.js';
import type {
  SendParam,
  MessagingFee,
  OFTReceipt,
  OFTLimit,
  OFTFeeDetail,
  LayerZeroBridgeRoute,
  LayerZeroScanMessage,
  LayerZeroScanResponse,
} from '../bridges/layerZeroUtils.js';

/**
 * Creates a mock SendParam for testing.
 * Default: Arbitrum → Plasma route with 10,000 USDT
 */
export function createMockSendParam(overrides?: Partial<SendParam>): SendParam {
  return {
    dstEid: 30383, // Plasma EID
    to: '0x' + '0'.repeat(64), // zero bytes32
    amountLD: 10000000000n, // 10,000 USDT (6 decimals)
    minAmountLD: 9997000000n, // after 0.03% fee
    extraOptions: '0x',
    composeMsg: '0x',
    oftCmd: '0x',
    ...overrides,
  };
}

/**
 * Creates a mock OFT quote response (quoteOFT result).
 * Includes oftLimit, oftFeeDetails, and oftReceipt.
 */
export function createMockQuoteOFTResponse(overrides?: {
  oftLimit?: Partial<OFTLimit>;
  oftFeeDetails?: OFTFeeDetail[];
  oftReceipt?: Partial<OFTReceipt>;
}): {
  oftLimit: OFTLimit;
  oftFeeDetails: OFTFeeDetail[];
  oftReceipt: OFTReceipt;
} {
  return {
    oftLimit: {
      minAmountLD: 0n,
      maxAmountLD: 1000000000000n,
      ...overrides?.oftLimit,
    },
    oftFeeDetails: overrides?.oftFeeDetails ?? [
      {
        feeAmountLD: 3000000n, // 0.03% of 10,000 USDT = 3 USDT
        description: 'Protocol fee',
      },
    ],
    oftReceipt: {
      amountSentLD: 10000000000n,
      amountReceivedLD: 9997000000n,
      ...overrides?.oftReceipt,
    },
  };
}

/**
 * Creates a mock MessagingFee (quoteSend result).
 * Default: 0.001 ETH native fee, 0 LZ token fee
 */
export function createMockQuoteSendResponse(
  overrides?: Partial<MessagingFee>,
): MessagingFee {
  return {
    nativeFee: 1000000000000000n, // 0.001 ETH in wei
    lzTokenFee: 0n,
    ...overrides,
  };
}

/**
 * Creates a mock LayerZero Scan API response.
 * Default: single DELIVERED message
 */
export function createMockLZScanResponse(
  status: 'INFLIGHT' | 'DELIVERED' | 'FAILED' | 'BLOCKED' = 'DELIVERED',
  overrides?: Partial<LayerZeroScanMessage>,
): LayerZeroScanResponse {
  return {
    messages: [
      {
        status,
        dstTxHash: '0x' + 'a'.repeat(64),
        ...overrides,
      },
    ],
  };
}

/**
 * Creates a mock LayerZeroBridgeRoute.
 * Default: Arbitrum → Plasma native OFT route
 */
export function createMockLayerZeroBridgeRoute(
  overrides?: Partial<LayerZeroBridgeRoute>,
): LayerZeroBridgeRoute {
  return {
    sendParam: createMockSendParam(),
    messagingFee: createMockQuoteSendResponse(),
    oftContract: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92', // Arbitrum native OFT
    usdtContract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum USDT
    fromChainId: 42161, // Arbitrum
    toChainId: 9745, // Plasma
    ...overrides,
  };
}

/**
 * Creates a mock BridgeQuote with LayerZero route.
 * Default: 10,000 USDT from Arbitrum to Plasma
 */
export function createMockLayerZeroQuote(
  overrides?: Partial<BridgeQuote<LayerZeroBridgeRoute>>,
): BridgeQuote<LayerZeroBridgeRoute> {
  const requestParams: BridgeQuoteParams = {
    fromChain: 42161, // Arbitrum
    toChain: 9745, // Plasma
    fromToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum USDT
    toToken: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', // Plasma USDT
    fromAddress: '0x1234567890123456789012345678901234567890',
    fromAmount: 10000000000n,
  };

  return {
    id: 'mock-quote-id',
    tool: 'layerzero',
    fromAmount: 10000000000n,
    toAmount: 9997000000n,
    toAmountMin: 9997000000n,
    executionDuration: 120,
    gasCosts: 1000000000000000n, // 0.001 ETH
    feeCosts: 3000000n, // 3 USDT
    route: createMockLayerZeroBridgeRoute(),
    requestParams,
    ...overrides,
  };
}

/**
 * Creates a mock fetch function that returns predefined responses.
 * Useful for stubbing API calls in tests.
 *
 * @param responses Map of URL patterns to response objects
 * @returns A fetch-compatible function
 *
 * @example
 * const mockFetch = createMockFetch(
 *   new Map([
 *     ['scan.layerzero-api.com', { ok: true, status: 200, body: { messages: [...] } }],
 *   ])
 * );
 * globalThis.fetch = mockFetch;
 */
export function createMockFetch(
  responses: Map<string, { ok: boolean; status: number; body: unknown }>,
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = String(input);

    // Find matching response by checking if url includes any key
    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        return {
          ok: response.ok,
          status: response.status,
          json: async () => response.body,
          text: async () => JSON.stringify(response.body),
        } as Response;
      }
    }

    // Default: 404 not found
    return {
      ok: false,
      status: 404,
      json: async () => ({ messages: [] }),
      text: async () => '{"messages":[]}',
    } as Response;
  }) as typeof fetch;
}
