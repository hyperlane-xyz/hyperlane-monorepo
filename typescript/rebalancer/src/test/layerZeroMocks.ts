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
  LayerZeroEvmBridgeRoute,
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
    to: '0x0000000000000000000000001234567890123456789012345678901234567890',
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
  status:
    | 'INFLIGHT'
    | 'DELIVERED'
    | 'FAILED'
    | 'BLOCKED'
    | 'APPLICATION_BURNED' = 'DELIVERED',
  overrides?: {
    srcEid?: number;
    dstEid?: number;
    dstTxHash?: string;
    destinationStatus?: string;
    composeStatus?: string;
    composeTxHash?: string;
  },
): LayerZeroScanResponse {
  const destination: LayerZeroScanMessage['destination'] = {
    status: overrides?.destinationStatus ?? 'SUCCEEDED',
    tx: {
      txHash: overrides?.dstTxHash ?? '0x' + 'a'.repeat(64),
    },
    lzCompose: {
      status: overrides?.composeStatus ?? 'N/A',
      txs: overrides?.composeTxHash
        ? [{ txHash: overrides.composeTxHash }]
        : [],
    },
  };

  return {
    data: [
      {
        pathway: {
          srcEid: overrides?.srcEid ?? 30110,
          dstEid: overrides?.dstEid ?? 30383,
        },
        status: { name: status },
        destination,
      },
    ],
  };
}

/**
 * Creates a mock LayerZeroBridgeRoute.
 * Default: Arbitrum → Plasma native OFT route
 */
export function createMockLayerZeroBridgeRoute(
  overrides?: Partial<LayerZeroEvmBridgeRoute>,
): LayerZeroEvmBridgeRoute {
  return {
    kind: 'evm',
    sendParam: createMockSendParam(),
    messagingFee: createMockQuoteSendResponse(),
    oftContract: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92',
    usdtContract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    fromChainId: 42161,
    toChainId: 9745,
    network: 'native',
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
  return async (input: URL | RequestInfo) => {
    const url = String(input);

    // Find matching response by checking if url includes any key
    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    // Default: 404 not found
    return new Response('{"messages":[]}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}
