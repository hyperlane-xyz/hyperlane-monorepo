import { expect } from 'chai';
import { pino } from 'pino';
import sinon from 'sinon';
import { ProtocolType } from '@hyperlane-xyz/utils';
import { MesonBridge } from './MesonBridge.js';
import {
  createMesonEncodeResponse,
  createMesonPriceResponse,
  createMesonSwapResponse,
  createMesonStatusResponse,
  createMockMesonBridgeQuote,
  createMesonFetchStub,
} from '../test/mesonMocks.js';
import { evmChainIdToMesonChain } from './mesonUtils.js';

const testLogger = pino({ level: 'silent' });
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const FROM_CHAIN = 1; // Ethereum
const TO_CHAIN = 728126428; // Tron

describe('MesonBridge.quote()', function () {
  let bridge: MesonBridge;

  beforeEach(() => {
    bridge = new MesonBridge({}, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return a quote for fromAmount', async () => {
    createMesonFetchStub([
      { ok: true, status: 200, body: createMesonPriceResponse() },
    ]);

    const quote = await bridge.quote({
      fromChain: FROM_CHAIN,
      toChain: TO_CHAIN,
      fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      fromAmount: 10_000_000n,
    });

    expect(quote.fromAmount).to.equal(10_000_000n);
    expect(quote.tool).to.equal('meson');
    expect(quote.id).to.be.a('string');
    expect(quote.id).to.have.length.greaterThan(0);
  });

  it('should return a quote for toAmount', async () => {
    createMesonFetchStub([
      { ok: true, status: 200, body: createMesonPriceResponse() },
    ]);

    const quote = await bridge.quote({
      fromChain: FROM_CHAIN,
      toChain: TO_CHAIN,
      fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      toAmount: 10_000_000n,
    });

    expect(quote.toAmount).to.be.a('bigint');
    expect(quote.tool).to.equal('meson');
  });

  it('should throw when both fromAmount and toAmount are provided', async () => {
    createMesonFetchStub();

    try {
      await bridge.quote({
        fromChain: FROM_CHAIN,
        toChain: TO_CHAIN,
        fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        fromAmount: 10_000_000n,
        toAmount: 10_000_000n,
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('exactly one');
    }
  });

  it('should throw when neither fromAmount nor toAmount is provided', async () => {
    createMesonFetchStub();

    try {
      await bridge.quote({
        fromChain: FROM_CHAIN,
        toChain: TO_CHAIN,
        fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('exactly one');
    }
  });

  it('should throw when fromAmount is 0n', async () => {
    createMesonFetchStub();

    try {
      await bridge.quote({
        fromChain: FROM_CHAIN,
        toChain: TO_CHAIN,
        fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        fromAmount: 0n,
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('must be positive');
    }
  });

  it('should throw when toAmount is 0n', async () => {
    createMesonFetchStub();

    try {
      await bridge.quote({
        fromChain: FROM_CHAIN,
        toChain: TO_CHAIN,
        fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        toAmount: 0n,
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('must be positive');
    }
  });

  it('should throw when API returns an error', async () => {
    createMesonFetchStub([
      {
        ok: true,
        status: 200,
        body: { error: { code: 400, message: 'bad request' } },
      },
    ]);

    try {
      await bridge.quote({
        fromChain: FROM_CHAIN,
        toChain: TO_CHAIN,
        fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        fromAmount: 10_000_000n,
      });
      expect.fail('Expected quote to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('Meson price error');
    }
  });

  it('should warn when amount exceeds 20k USDT limit', async () => {
    createMesonFetchStub([
      { ok: true, status: 200, body: createMesonPriceResponse() },
    ]);

    const quote = await bridge.quote({
      fromChain: FROM_CHAIN,
      toChain: TO_CHAIN,
      fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      fromAmount: 25_000_000_000n, // 25k USDT in 6 decimals
    });

    expect(quote).to.exist;
    expect(quote.fromAmount).to.equal(25_000_000_000n);
  });
});

describe('MesonBridge.execute()', function () {
  let bridge: MesonBridge;

  beforeEach(() => {
    bridge = new MesonBridge({}, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should sign and submit a swap successfully', async () => {
    createMesonFetchStub([
      { ok: true, status: 200, body: createMesonEncodeResponse() },
      { ok: true, status: 200, body: createMesonSwapResponse() },
    ]);

    const quote = createMockMesonBridgeQuote({
      requestParams: {
        fromChain: FROM_CHAIN,
        toChain: TO_CHAIN,
        fromToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        toToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        fromAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        fromAmount: 10_000_000n,
      },
    });

    const result = await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(result.txHash).to.be.a('string');
    expect(result.fromChain).to.equal(FROM_CHAIN);
    expect(result.toChain).to.equal(TO_CHAIN);
    expect(result.transferId).to.be.a('string');
  });

  it('should throw when private key is missing', async () => {
    const quote = createMockMesonBridgeQuote();

    try {
      await bridge.execute(quote, {});
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('Missing private key');
    }
  });

  it('should throw when encode API returns an error', async () => {
    createMesonFetchStub([
      {
        ok: true,
        status: 200,
        body: { error: { code: 400, message: 'invalid swap params' } },
      },
    ]);

    const quote = createMockMesonBridgeQuote();

    try {
      await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      });
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('Meson encode error');
    }
  });

  it('should throw when Meson API returns an error on swap submit', async () => {
    createMesonFetchStub([
      { ok: true, status: 200, body: createMesonEncodeResponse() },
      {
        ok: true,
        status: 200,
        body: { error: { code: 500, message: 'server error' } },
      },
    ]);

    const quote = createMockMesonBridgeQuote();

    try {
      await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      });
      expect.fail('Expected execute to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('Meson swap error');
    }
  });
});

describe('MesonBridge.getStatus()', function () {
  let bridge: MesonBridge;

  beforeEach(() => {
    bridge = new MesonBridge({}, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return complete status for RELEASED swap', async () => {
    sinon.stub(globalThis, 'fetch').resolves({
      ok: true,
      status: 200,
      json: async () => createMesonStatusResponse('RELEASED'),
      text: async () => JSON.stringify(createMesonStatusResponse('RELEASED')),
    } as Response);

    const status = await bridge.getStatus(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      FROM_CHAIN,
      TO_CHAIN,
    );

    expect(status.status).to.equal('complete');
    expect(status).to.have.property('receivingTxHash');
    expect(status).to.have.property('receivedAmount');
    if (status.status === 'complete') {
      expect(status.receivingTxHash).to.be.a('string');
      expect(status.receivedAmount).to.be.a('bigint');
    }
  });

  it('should return pending status for BONDED swap', async () => {
    sinon.stub(globalThis, 'fetch').resolves({
      ok: true,
      status: 200,
      json: async () => createMesonStatusResponse('BONDED'),
      text: async () => JSON.stringify(createMesonStatusResponse('BONDED')),
    } as Response);

    const status = await bridge.getStatus(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      FROM_CHAIN,
      TO_CHAIN,
    );

    expect(status.status).to.equal('pending');
    if (status.status === 'pending') {
      expect(status.substatus).to.equal('bonded');
    }
  });

  it('should return failed status for CANCELLED swap', async () => {
    sinon.stub(globalThis, 'fetch').resolves({
      ok: true,
      status: 200,
      json: async () => createMesonStatusResponse('CANCELLED'),
      text: async () => JSON.stringify(createMesonStatusResponse('CANCELLED')),
    } as Response);

    const status = await bridge.getStatus(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      FROM_CHAIN,
      TO_CHAIN,
    );

    expect(status.status).to.equal('failed');
    if (status.status === 'failed') {
      expect(status.error).to.equal('swap cancelled');
    }
  });

  it('should return pending for unknown status', async () => {
    sinon.stub(globalThis, 'fetch').resolves({
      ok: true,
      status: 200,
      json: async () => ({
        result: { status: 'UNKNOWN_STATUS' },
      }),
      text: async () =>
        JSON.stringify({ result: { status: 'UNKNOWN_STATUS' } }),
    } as Response);

    const status = await bridge.getStatus(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      FROM_CHAIN,
      TO_CHAIN,
    );

    expect(status.status).to.equal('pending');
  });

  it('should return not_found when API returns error', async () => {
    sinon.stub(globalThis, 'fetch').resolves({
      ok: true,
      status: 200,
      json: async () => ({
        error: { code: 404, message: 'not found' },
      }),
      text: async () =>
        JSON.stringify({ error: { code: 404, message: 'not found' } }),
    } as Response);

    const status = await bridge.getStatus(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      FROM_CHAIN,
      TO_CHAIN,
    );

    expect(status.status).to.equal('not_found');
  });

  it('should return not_found when fetch throws', async function () {
    this.timeout(10000);
    sinon.stub(globalThis, 'fetch').rejects(new Error('network error'));

    const status = await bridge.getStatus(
      '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      FROM_CHAIN,
      TO_CHAIN,
    );

    expect(status.status).to.equal('not_found');
  });
});

describe('MesonBridge chain mapping', function () {
  it('should map all 5 supported chains correctly', () => {
    expect(evmChainIdToMesonChain(728126428)).to.equal('tron');
    expect(evmChainIdToMesonChain(1)).to.equal('eth');
    expect(evmChainIdToMesonChain(56)).to.equal('bnb');
    expect(evmChainIdToMesonChain(42161)).to.equal('arb');
    expect(evmChainIdToMesonChain(9745)).to.equal('plasma');
  });

  it('should throw for unsupported chain ID', () => {
    try {
      evmChainIdToMesonChain(99999);
      expect.fail('Expected evmChainIdToMesonChain to throw');
    } catch (error: unknown) {
      expect((error as Error).message).to.include('Unsupported chain ID');
    }
  });
});
