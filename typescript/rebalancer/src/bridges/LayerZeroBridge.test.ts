import { expect } from 'chai';
import sinon from 'sinon';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';
import { ethers } from 'ethers';

import type { ExternalBridgeConfig } from '../interfaces/IExternalBridge.js';
import { LayerZeroBridge } from './LayerZeroBridge.js';
import { OFT_ABI } from './layerZeroUtils.js';
import {
  createMockLayerZeroQuote,
  createMockLayerZeroBridgeRoute,
  createMockLZScanResponse,
  createMockQuoteOFTResponse,
  createMockQuoteSendResponse,
  createMockFetch,
} from '../test/layerZeroMocks.js';

const testLogger = pino({ level: 'silent' });
const TEST_EVM_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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
    arbitrum: {
      chainId: 42161,
      name: 'arbitrum',
      domainId: 42161,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://arb-rpc.example.com' }],
    },
    plasma: {
      chainId: 7758,
      name: 'plasma',
      domainId: 7758,
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

const BASE_PARAMS = {
  fromChain: 42161,
  toChain: 7758,
  fromToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  toToken: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
  fromAddress: '0x1234567890123456789012345678901234567890',
  toAddress: '0x1234567890123456789012345678901234567890',
};

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function stubContractConstructor(
  factory: (...args: unknown[]) => unknown,
): sinon.SinonStub {
  const constructorCallStub = sinon
    .stub()
    .callsFake((...args: unknown[]) => factory(...args));

  class FakeContract {
    constructor(...args: unknown[]) {
      return constructorCallStub(...args) as object;
    }
  }

  sinon.replaceGetter(ethers, 'Contract', () => {
    return FakeContract as unknown as typeof ethers.Contract;
  });

  return constructorCallStub;
}

describe('LayerZeroBridge', function () {
  let bridge: LayerZeroBridge;

  beforeEach(() => {
    bridge = new LayerZeroBridge(BRIDGE_CONFIG, testLogger);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('quote()', function () {
    it('returns valid quote for EVM→EVM route (Arbitrum→Plasma)', async () => {
      const quoteOFTResponse = createMockQuoteOFTResponse();
      const quoteSendResponse = createMockQuoteSendResponse();

      const quoteOFTStub = sinon
        .stub()
        .resolves([
          quoteOFTResponse.oftLimit,
          quoteOFTResponse.oftFeeDetails,
          quoteOFTResponse.oftReceipt,
        ]);
      const quoteSendStub = sinon.stub().resolves([quoteSendResponse]);
      stubContractConstructor(() => ({
        quoteOFT: quoteOFTStub,
        quoteSend: quoteSendStub,
      }));

      const quote = await bridge.quote({
        ...BASE_PARAMS,
        fromAmount: 10000000000n,
      });

      expect(quote.tool).to.equal('layerzero');
      expect(quote.fromAmount).to.equal(10000000000n);
      expect(quote.toAmount).to.equal(9997000000n);
      expect(quote.feeCosts).to.equal(3000000n);
      expect(quoteOFTStub.calledOnce).to.equal(true);
      expect(quoteSendStub.calledOnce).to.equal(true);
    });

    it('returns valid quote for Tron→EVM route (Tron→Arbitrum)', async () => {
      const iface = new ethers.utils.Interface(OFT_ABI);
      const quoteOFTResponse = createMockQuoteOFTResponse();
      const quoteSendResponse = createMockQuoteSendResponse();

      const encodedQuoteOFT = iface.encodeFunctionResult('quoteOFT', [
        [
          quoteOFTResponse.oftLimit.minAmountLD,
          quoteOFTResponse.oftLimit.maxAmountLD,
        ],
        quoteOFTResponse.oftFeeDetails.map((f) => [
          f.feeAmountLD,
          f.description,
        ]),
        [
          quoteOFTResponse.oftReceipt.amountSentLD,
          quoteOFTResponse.oftReceipt.amountReceivedLD,
        ],
      ]);
      const encodedQuoteSend = iface.encodeFunctionResult('quoteSend', [
        [quoteSendResponse.nativeFee, quoteSendResponse.lzTokenFee],
      ]);

      const fetchStub = sinon
        .stub(globalThis, 'fetch')
        .callsFake(async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            data?: string;
          };
          const selector = body.data?.slice(0, 10) ?? '';
          const quoteOFTSelector = iface.getSighash('quoteOFT');

          if (selector === quoteOFTSelector) {
            return makeResponse({
              constant_result: [encodedQuoteOFT.slice(2)],
            });
          }
          return makeResponse({
            constant_result: [encodedQuoteSend.slice(2)],
          });
        });

      const quote = await bridge.quote({
        ...BASE_PARAMS,
        fromChain: 728126428,
        toChain: 42161,
        fromAmount: 10000000000n,
        fromAddress: '4176f8f34f5e4000000000000000000000000000',
      });

      expect(quote.tool).to.equal('layerzero');
      expect(quote.fromAmount).to.equal(10000000000n);
      expect(quote.toAmount).to.equal(9997000000n);
      expect(quote.gasCosts).to.equal(1000000000000000n);
      expect(fetchStub.callCount).to.equal(2);
    });

    it('handles reverse quote (toAmount specified)', async () => {
      const quoteOFTResponse = createMockQuoteOFTResponse();
      const quoteSendResponse = createMockQuoteSendResponse();

      const quoteOFTStub = sinon
        .stub()
        .resolves([
          quoteOFTResponse.oftLimit,
          quoteOFTResponse.oftFeeDetails,
          quoteOFTResponse.oftReceipt,
        ]);
      const quoteSendStub = sinon.stub().resolves([quoteSendResponse]);
      stubContractConstructor(() => ({
        quoteOFT: quoteOFTStub,
        quoteSend: quoteSendStub,
      }));

      const quote = await bridge.quote({
        ...BASE_PARAMS,
        toAmount: 9997000000n,
      });

      expect(quote.fromAmount).to.equal((9997000000n * 10000n) / 9970n);
      expect(quoteOFTStub.calledOnce).to.equal(true);
      expect(quoteSendStub.calledOnce).to.equal(true);
    });

    it('throws when both fromAmount and toAmount provided', async () => {
      let threw = false;
      try {
        await bridge.quote({
          ...BASE_PARAMS,
          fromAmount: 100n,
          toAmount: 100n,
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include('exactly one');
      }
      expect(threw).to.equal(true);
    });

    it('throws when neither fromAmount nor toAmount provided', async () => {
      let threw = false;
      try {
        await bridge.quote({
          ...BASE_PARAMS,
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include('Must specify either');
      }
      expect(threw).to.equal(true);
    });

    it('throws for unsupported route', async () => {
      let threw = false;
      try {
        await bridge.quote({
          ...BASE_PARAMS,
          fromChain: 56,
          toChain: 1,
          fromAmount: 1000000n,
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include('Unsupported route');
      }
      expect(threw).to.equal(true);
    });

    it('throws for cross-system route (Tron→Plasma)', async () => {
      let threw = false;
      try {
        await bridge.quote({
          ...BASE_PARAMS,
          fromChain: 728126428,
          toChain: 7758,
          fromAmount: 1000000n,
          fromAddress: '4176f8f34f5e4000000000000000000000000000',
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include('Unsupported route');
      }
      expect(threw).to.equal(true);
    });
  });

  describe('execute()', function () {
    it('executes EVM-origin transfer and returns txHash', async () => {
      const quote = createMockLayerZeroQuote();
      const approveWaitStub = sinon.stub().resolves();
      const sendWaitStub = sinon.stub().resolves();
      const approveStub = sinon.stub().resolves({
        wait: approveWaitStub,
      } as {
        wait: () => Promise<void>;
      });
      const sendStub = sinon.stub().resolves({
        wait: sendWaitStub,
        hash: '0xdeadbeef',
      });

      const allowanceStub = sinon.stub().resolves(0n);
      const contractCtorStub = stubContractConstructor((_address, abi) => {
        const abiText = JSON.stringify(abi);
        if (abiText.includes('allowance')) {
          return {
            allowance: allowanceStub,
            approve: approveStub,
          };
        }
        return {
          send: sendStub,
        };
      });

      const result = await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_EVM_PRIVATE_KEY,
      });

      expect(result).to.deep.equal({
        txHash: '0xdeadbeef',
        fromChain: 42161,
        toChain: 7758,
      });
      expect(allowanceStub.calledOnce).to.equal(true);
      expect(approveStub.calledOnce).to.equal(true);
      expect(sendStub.calledOnce).to.equal(true);
      expect(contractCtorStub.callCount).to.equal(2);
    });

    it('skips approve when allowance is sufficient', async () => {
      const quote = createMockLayerZeroQuote();
      const approveStub = sinon.stub().resolves({
        wait: sinon.stub().resolves(),
      } as {
        wait: () => Promise<void>;
      });
      const sendStub = sinon.stub().resolves({
        wait: sinon.stub().resolves(),
        hash: '0xfeedface',
      });

      stubContractConstructor((_address, abi) => {
        const abiText = JSON.stringify(abi);
        if (abiText.includes('allowance')) {
          return {
            allowance: sinon.stub().resolves(ethers.constants.MaxUint256),
            approve: approveStub,
          };
        }
        return {
          send: sendStub,
        };
      });

      const result = await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_EVM_PRIVATE_KEY,
      });

      expect(result.txHash).to.equal('0xfeedface');
      expect(approveStub.called).to.equal(false);
      expect(sendStub.calledOnce).to.equal(true);
    });

    it('throws when EVM private key missing', async () => {
      const quote = createMockLayerZeroQuote();

      let threw = false;
      try {
        await bridge.execute(quote, {});
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include('Missing private key');
      }
      expect(threw).to.equal(true);
    });

    it('throws when Tron private key missing for Tron-origin', async () => {
      const tronRoute = createMockLayerZeroBridgeRoute({
        fromChainId: 728126428,
        toChainId: 42161,
      });
      const quote = createMockLayerZeroQuote({
        route: tronRoute,
        requestParams: {
          ...BASE_PARAMS,
          fromChain: 728126428,
          toChain: 42161,
          fromAmount: 10000000000n,
        },
      });

      let threw = false;
      try {
        await bridge.execute(quote, {
          [ProtocolType.Ethereum]: TEST_EVM_PRIVATE_KEY,
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.include('Missing private key');
      }
      expect(threw).to.equal(true);
    });
  });

  describe('getStatus()', function () {
    it('returns complete for DELIVERED status', async () => {
      sinon.stub(globalThis, 'fetch').callsFake(
        createMockFetch(
          new Map([
            [
              'scan.layerzero-api.com',
              {
                ok: true,
                status: 200,
                body: createMockLZScanResponse('DELIVERED', {
                  dstTxHash: '0x' + 'b'.repeat(64),
                }),
              },
            ],
          ]),
        ),
      );

      const status = await bridge.getStatus('0xabc123', 42161, 7758);

      expect(status).to.deep.equal({
        status: 'complete',
        receivingTxHash: '0x' + 'b'.repeat(64),
        receivedAmount: 0n,
      });
    });

    it('returns pending for INFLIGHT status', async () => {
      sinon.stub(globalThis, 'fetch').callsFake(
        createMockFetch(
          new Map([
            [
              'scan.layerzero-api.com',
              {
                ok: true,
                status: 200,
                body: createMockLZScanResponse('INFLIGHT'),
              },
            ],
          ]),
        ),
      );

      const status = await bridge.getStatus('0xabc123', 42161, 7758);
      expect(status).to.deep.equal({
        status: 'pending',
        substatus: 'INFLIGHT',
      });
    });

    it('returns failed for FAILED status', async () => {
      sinon.stub(globalThis, 'fetch').callsFake(
        createMockFetch(
          new Map([
            [
              'scan.layerzero-api.com',
              {
                ok: true,
                status: 200,
                body: createMockLZScanResponse('FAILED'),
              },
            ],
          ]),
        ),
      );

      const status = await bridge.getStatus('0xabc123', 42161, 7758);
      expect(status).to.deep.equal({ status: 'failed', error: 'FAILED' });
    });

    it('returns failed for BLOCKED status', async () => {
      sinon.stub(globalThis, 'fetch').callsFake(
        createMockFetch(
          new Map([
            [
              'scan.layerzero-api.com',
              {
                ok: true,
                status: 200,
                body: createMockLZScanResponse('BLOCKED'),
              },
            ],
          ]),
        ),
      );

      const status = await bridge.getStatus('0xabc123', 42161, 7758);
      expect(status).to.deep.equal({ status: 'failed', error: 'BLOCKED' });
    });

    it('returns not_found for empty messages array', async () => {
      sinon.stub(globalThis, 'fetch').callsFake(
        createMockFetch(
          new Map([
            [
              'scan.layerzero-api.com',
              {
                ok: true,
                status: 200,
                body: { messages: [] },
              },
            ],
          ]),
        ),
      );

      const status = await bridge.getStatus('0xabc123', 42161, 7758);
      expect(status).to.deep.equal({ status: 'not_found' });
    });

    it('normalizes Tron tx hash by adding 0x prefix', async () => {
      let calledUrl = '';
      sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
        calledUrl = String(input);
        return makeResponse(createMockLZScanResponse('INFLIGHT'));
      });

      await bridge.getStatus('abc123', 42161, 7758);
      expect(calledUrl).to.include('/0xabc123');
    });
  });
});
