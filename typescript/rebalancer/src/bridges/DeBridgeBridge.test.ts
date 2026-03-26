import { expect } from 'chai';
import sinon from 'sinon';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ExternalBridgeConfig } from '../interfaces/IExternalBridge.js';
import { DeBridgeBridge } from './DeBridgeBridge.js';
import {
  hyperlaneChainIdToDebridge,
  formatAddressForDebridge,
  isDebridgeTronChain,
  DEBRIDGE_TRON_CHAIN_ID,
  type DeBridgeQuoteResponse,
  type DeBridgeOrderStatusResponse,
} from './deBridgeUtils.js';

const testLogger = pino({ level: 'silent' });

const BRIDGE_CONFIG: ExternalBridgeConfig = {
  integrator: 'test-rebalancer',
  chainMetadata: {
    ethereum: {
      chainId: 1,
      name: 'ethereum',
      domainId: 1,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://eth-rpc.example.com' }],
    },
    bsc: {
      chainId: 56,
      name: 'bsc',
      domainId: 56,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://bsc-rpc.example.com' }],
    },
    arbitrum: {
      chainId: 42161,
      name: 'arbitrum',
      domainId: 42161,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://arb-rpc.example.com' }],
    },
    plasma: {
      chainId: 9745,
      name: 'plasma',
      domainId: 9745,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://plasma-rpc.example.com' }],
    },
    tron: {
      chainId: 728126428,
      name: 'tron',
      domainId: 728126428,
      protocol: 'tron' as ProtocolType,
      rpcUrls: [{ http: 'https://api.trongrid.io' }],
    },
  },
};

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function createMockQuoteResponse(
  overrides?: Partial<DeBridgeQuoteResponse>,
): DeBridgeQuoteResponse {
  return {
    estimation: {
      srcChainTokenIn: {
        chainId: 56,
        address: '0x55d398326f99059fF775485246999027B3197955',
        name: 'USDT',
        symbol: 'USDT',
        decimals: 18,
        amount: '5000000000000000000',
      },
      dstChainTokenOut: {
        chainId: 100000026,
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        name: 'Tether USD',
        symbol: 'USDT',
        decimals: 6,
        amount: '4998000',
      },
    },
    fixFee: '1000',
    protocolFee: '500',
    orderId: '0xabc123def456',
    ...overrides,
  };
}

function createMockStatusResponse(
  status: string,
  overrides?: Partial<DeBridgeOrderStatusResponse>,
): DeBridgeOrderStatusResponse {
  const base: DeBridgeOrderStatusResponse = { status, ...overrides };
  if (status === 'Fulfilled' || status === 'ClaimedUnlock') {
    base.fulfilledDstEventMetadata = {
      transactionHash: { stringValue: '0x' + 'b'.repeat(64) },
      receivedAmount: { bigIntegerValue: '4998000' },
      ...overrides?.fulfilledDstEventMetadata,
    };
  }
  return base;
}

// ============================================================================
// deBridgeUtils — Chain ID mapping
// ============================================================================

describe('hyperlaneChainIdToDebridge()', function () {
  it('maps Ethereum (1 → 1)', () => {
    expect(hyperlaneChainIdToDebridge(1)).to.equal(1);
  });

  it('maps BSC (56 → 56)', () => {
    expect(hyperlaneChainIdToDebridge(56)).to.equal(56);
  });

  it('maps Arbitrum (42161 → 42161)', () => {
    expect(hyperlaneChainIdToDebridge(42161)).to.equal(42161);
  });

  it('maps Plasma (9745 → 100000028)', () => {
    expect(hyperlaneChainIdToDebridge(9745)).to.equal(100000028);
  });

  it('maps Tron (728126428 → 100000026)', () => {
    expect(hyperlaneChainIdToDebridge(728126428)).to.equal(100000026);
  });

  it('throws for unsupported chain (99999)', () => {
    let threw = false;
    try {
      hyperlaneChainIdToDebridge(99999);
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('99999');
      expect((error as Error).message).to.include('not supported');
    }
    expect(threw).to.equal(true);
  });
});

// ============================================================================
// deBridgeUtils — isDebridgeTronChain
// ============================================================================

describe('isDebridgeTronChain()', function () {
  it('returns true for DEBRIDGE_TRON_CHAIN_ID', () => {
    expect(isDebridgeTronChain(DEBRIDGE_TRON_CHAIN_ID)).to.equal(true);
  });

  it('returns false for EVM chain IDs', () => {
    expect(isDebridgeTronChain(1)).to.equal(false);
    expect(isDebridgeTronChain(56)).to.equal(false);
    expect(isDebridgeTronChain(42161)).to.equal(false);
  });
});

// ============================================================================
// deBridgeUtils — Address formatting
// ============================================================================

describe('formatAddressForDebridge()', function () {
  it('returns EVM addresses unchanged for EVM chains', () => {
    const addr = '0x55d398326f99059fF775485246999027B3197955';
    expect(formatAddressForDebridge(addr, 1)).to.equal(addr);
    expect(formatAddressForDebridge(addr, 56)).to.equal(addr);
    expect(formatAddressForDebridge(addr, 42161)).to.equal(addr);
  });

  it('returns already-base58 Tron address unchanged', () => {
    const tronBase58 = 'TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo5';
    expect(
      formatAddressForDebridge(tronBase58, DEBRIDGE_TRON_CHAIN_ID),
    ).to.equal(tronBase58);
  });

  it('converts hex 0x address to Tron base58 for Tron chain', () => {
    // Known conversion: 0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5
    // Tron hex with 41 prefix: 413e0A78A330F2b97059A4D507ca9d8292b65B6FB5
    // Expected base58: TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo5
    const hexAddr = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';
    const result = formatAddressForDebridge(hexAddr, DEBRIDGE_TRON_CHAIN_ID);
    expect(result).to.equal('TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo5');
  });

  it('converts 41-prefixed hex address to Tron base58', () => {
    const hex41 = '413e0A78A330F2b97059A4D507ca9d8292b65B6FB5';
    const result = formatAddressForDebridge(hex41, DEBRIDGE_TRON_CHAIN_ID);
    expect(result).to.equal('TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo5');
  });

  it('returns non-Tron-like address as-is for Tron chain', () => {
    // Address that doesn't match 0x, 41, or T-prefix patterns — returned unchanged
    const weirdAddr = 'someRandomString';
    expect(
      formatAddressForDebridge(weirdAddr, DEBRIDGE_TRON_CHAIN_ID),
    ).to.equal(weirdAddr);
  });
});

// ============================================================================
// DeBridgeBridge — quote()
// ============================================================================

describe('DeBridgeBridge.quote()', function () {
  let bridge: DeBridgeBridge;

  beforeEach(() => {
    bridge = new DeBridgeBridge(BRIDGE_CONFIG, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns BridgeQuote with correct amounts from API response', async () => {
    const mockData = createMockQuoteResponse();
    sinon.stub(globalThis, 'fetch').resolves(makeResponse(mockData));

    const quote = await bridge.quote({
      fromChain: 56,
      toChain: 728126428,
      fromToken: '0x55d398326f99059fF775485246999027B3197955',
      toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      fromAddress: '0x1234567890123456789012345678901234567890',
      fromAmount: 5000000000000000000n,
    });

    expect(quote.tool).to.equal('debridge');
    expect(quote.fromAmount).to.equal(5000000000000000000n);
    expect(quote.toAmount).to.equal(4998000n);
    expect(quote.toAmountMin).to.equal(4998000n);
    expect(quote.feeCosts).to.equal(1500n); // 1000 + 500
    expect(quote.gasCosts).to.equal(0n);
    expect(quote.executionDuration).to.equal(60);
    expect(quote.route).to.deep.equal(mockData);
    expect(quote.id).to.be.a('string').and.have.length.greaterThan(0);
  });

  it('uses srcChainTokenIn amount as fromAmount when toAmount is specified', async () => {
    const mockData = createMockQuoteResponse();
    sinon.stub(globalThis, 'fetch').resolves(makeResponse(mockData));

    const quote = await bridge.quote({
      fromChain: 56,
      toChain: 728126428,
      fromToken: '0x55d398326f99059fF775485246999027B3197955',
      toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      fromAddress: '0x1234567890123456789012345678901234567890',
      toAmount: 4998000n,
    });

    // When toAmount is specified (fromAmount undefined), fromAmount comes from API response
    expect(quote.fromAmount).to.equal(5000000000000000000n);
    expect(quote.toAmount).to.equal(4998000n);
  });

  it('throws when API returns error response (no estimation)', async () => {
    const errorResponse: DeBridgeQuoteResponse = {
      errorCode: 1001,
      errorId: 'INSUFFICIENT_LIQUIDITY',
      errorMessage: 'Not enough liquidity',
    };
    sinon.stub(globalThis, 'fetch').resolves(makeResponse(errorResponse));

    let threw = false;
    try {
      await bridge.quote({
        fromChain: 56,
        toChain: 728126428,
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        fromAddress: '0x1234567890123456789012345678901234567890',
        fromAmount: 5000000000000000000n,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('Not enough liquidity');
    }
    expect(threw).to.equal(true);
  });

  it('throws when both fromAmount and toAmount provided', async () => {
    let threw = false;
    try {
      await bridge.quote({
        fromChain: 56,
        toChain: 728126428,
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        fromAddress: '0x1234567890123456789012345678901234567890',
        fromAmount: 100n,
        toAmount: 100n,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('Cannot specify both');
    }
    expect(threw).to.equal(true);
  });

  it('throws when neither fromAmount nor toAmount provided', async () => {
    let threw = false;
    try {
      await bridge.quote({
        fromChain: 56,
        toChain: 728126428,
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        fromAddress: '0x1234567890123456789012345678901234567890',
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('Must specify either');
    }
    expect(threw).to.equal(true);
  });

  it('throws for unsupported source chain', async () => {
    let threw = false;
    try {
      await bridge.quote({
        fromChain: 99999,
        toChain: 56,
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: '0x55d398326f99059fF775485246999027B3197955',
        fromAddress: '0x1234567890123456789012345678901234567890',
        fromAmount: 1000000n,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('99999');
      expect((error as Error).message).to.include('not supported');
    }
    expect(threw).to.equal(true);
  });

  it('constructs correct API URL with deBridge chain IDs', async () => {
    const mockData = createMockQuoteResponse();
    let calledUrl = '';
    sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
      calledUrl = String(input);
      return makeResponse(mockData);
    });

    await bridge.quote({
      fromChain: 9745, // Plasma → 100000028
      toChain: 728126428, // Tron → 100000026
      fromToken: '0x55d398326f99059fF775485246999027B3197955',
      toToken: '0x55d398326f99059fF775485246999027B3197955',
      fromAddress: '0x1234567890123456789012345678901234567890',
      fromAmount: 1000000n,
    });

    expect(calledUrl).to.include('srcChainId=100000028');
    expect(calledUrl).to.include('dstChainId=100000026');
    expect(calledUrl).to.include('prependOperatingExpenses=true');
  });

  it('formats Tron token addresses in API URL', async () => {
    const mockData = createMockQuoteResponse();
    let calledUrl = '';
    sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
      calledUrl = String(input);
      return makeResponse(mockData);
    });

    await bridge.quote({
      fromChain: 56,
      toChain: 728126428,
      fromToken: '0x55d398326f99059fF775485246999027B3197955',
      toToken: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5', // hex → base58
      fromAddress: '0x1234567890123456789012345678901234567890',
      fromAmount: 1000000n,
    });

    // Source EVM token should stay as hex
    expect(calledUrl).to.include(
      'srcChainTokenIn=0x55d398326f99059fF775485246999027B3197955',
    );
    // Destination Tron token should be converted to base58
    expect(calledUrl).to.include(
      'dstChainTokenOut=TFdFSWMovbz9PSKm6skvV4RCxuXq3nepo5',
    );
  });
});

// ============================================================================
// DeBridgeBridge — getStatus()
// ============================================================================

describe('DeBridgeBridge.getStatus()', function () {
  let bridge: DeBridgeBridge;

  beforeEach(() => {
    bridge = new DeBridgeBridge(BRIDGE_CONFIG, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('maps Fulfilled → complete with receivingTxHash', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse(createMockStatusResponse('Fulfilled')));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0x' + 'b'.repeat(64),
      receivedAmount: 4998000n,
    });
  });

  it('maps ClaimedUnlock → complete', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse(createMockStatusResponse('ClaimedUnlock')));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status.status).to.equal('complete');
    expect((status as { receivingTxHash: string }).receivingTxHash).to.equal(
      '0x' + 'b'.repeat(64),
    );
  });

  it('maps Created → pending', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse(createMockStatusResponse('Created')));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status).to.deep.equal({
      status: 'pending',
      substatus: 'Created',
    });
  });

  it('maps SentUnlock → pending', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse(createMockStatusResponse('SentUnlock')));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status).to.deep.equal({
      status: 'pending',
      substatus: 'SentUnlock',
    });
  });

  it('maps Cancelled → failed', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse(createMockStatusResponse('Cancelled')));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status).to.deep.equal({
      status: 'failed',
      error: 'Order cancelled',
    });
  });

  it('maps unknown status → pending with substatus', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse(createMockStatusResponse('SomeNewStatus')));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status).to.deep.equal({
      status: 'pending',
      substatus: 'SomeNewStatus',
    });
  });

  it('returns not_found when API returns error response', async () => {
    const errorResponse: DeBridgeOrderStatusResponse = {
      errorCode: 404,
      errorMessage: 'Order not found',
    };
    sinon.stub(globalThis, 'fetch').resolves(makeResponse(errorResponse));

    const status = await bridge.getStatus('0xnonexistent', 56, 728126428);

    expect(status).to.deep.equal({ status: 'not_found' });
  });

  it('returns not_found on fetch error', async function () {
    this.timeout(15000);
    sinon
      .stub(globalThis, 'fetch')
      .rejects(new Error('Network connection failed'));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status).to.deep.equal({ status: 'not_found' });
  });

  it('returns complete with empty receivingTxHash when metadata missing', async () => {
    const response: DeBridgeOrderStatusResponse = {
      status: 'Fulfilled',
      fulfilledDstEventMetadata: {},
    };
    sinon.stub(globalThis, 'fetch').resolves(makeResponse(response));

    const status = await bridge.getStatus('0xorder123', 56, 728126428);

    expect(status.status).to.equal('complete');
    expect((status as { receivingTxHash: string }).receivingTxHash).to.equal(
      '',
    );
    expect((status as { receivedAmount: bigint }).receivedAmount).to.equal(0n);
  });

  it('queries correct status API URL with orderId', async () => {
    let calledUrl = '';
    sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
      calledUrl = String(input);
      return makeResponse(createMockStatusResponse('Created'));
    });

    await bridge.getStatus('0xmyOrderId', 56, 728126428);

    expect(calledUrl).to.include('/dln/order/0xmyOrderId/status');
    expect(calledUrl).to.include('api.dln.trade');
  });
});

// ============================================================================
// DeBridgeBridge — fetchWithRetry error handling
// ============================================================================

describe('DeBridgeBridge.quote() error handling', function () {
  let bridge: DeBridgeBridge;

  beforeEach(() => {
    bridge = new DeBridgeBridge(BRIDGE_CONFIG, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('throws immediately on 4xx non-retryable errors (non-429)', async () => {
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse({ error: 'Bad request' }, false, 400));

    let threw = false;
    try {
      await bridge.quote({
        fromChain: 56,
        toChain: 42161,
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: '0x55d398326f99059fF775485246999027B3197955',
        fromAddress: '0x1234567890123456789012345678901234567890',
        fromAmount: 1000000n,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('HTTP 400');
    }
    expect(threw).to.equal(true);
    // Should NOT retry on 4xx — only 1 fetch call
    expect(fetchStub.callCount).to.equal(1);
  });

  it('throws immediately on 404 errors', async () => {
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(makeResponse({ error: 'Not found' }, false, 404));

    let threw = false;
    try {
      await bridge.quote({
        fromChain: 56,
        toChain: 42161,
        fromToken: '0x55d398326f99059fF775485246999027B3197955',
        toToken: '0x55d398326f99059fF775485246999027B3197955',
        fromAddress: '0x1234567890123456789012345678901234567890',
        fromAmount: 1000000n,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).to.include('HTTP 404');
    }
    expect(threw).to.equal(true);
    expect(fetchStub.callCount).to.equal(1);
  });

  it('retries on 5xx server errors', async function () {
    this.timeout(15000);
    const mockData = createMockQuoteResponse();
    const fetchStub = sinon.stub(globalThis, 'fetch');
    // First two calls fail with 500, third succeeds
    fetchStub
      .onFirstCall()
      .resolves(makeResponse({ error: 'Server error' }, false, 500));
    fetchStub
      .onSecondCall()
      .resolves(makeResponse({ error: 'Server error' }, false, 500));
    fetchStub.onThirdCall().resolves(makeResponse(mockData));

    const quote = await bridge.quote({
      fromChain: 56,
      toChain: 42161,
      fromToken: '0x55d398326f99059fF775485246999027B3197955',
      toToken: '0x55d398326f99059fF775485246999027B3197955',
      fromAddress: '0x1234567890123456789012345678901234567890',
      fromAmount: 5000000000000000000n,
    });

    expect(quote.tool).to.equal('debridge');
    expect(fetchStub.callCount).to.equal(3);
  });
});
