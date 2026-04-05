import { expect } from 'chai';
import sinon from 'sinon';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';
import { ethers } from 'ethers';

import type { ExternalBridgeConfig } from '../interfaces/IExternalBridge.js';
import { LayerZeroBridge } from './LayerZeroBridge.js';
import {
  getRouteNetwork,
  getOFTContractForRoute,
  isSupportedRoute,
} from './layerZeroUtils.js';
import {
  createMockLayerZeroQuote,
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
      chainId: 9745,
      name: 'plasma',
      domainId: 9745,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://plasma-rpc.example.com' }],
    },
  },
};

const BASE_PARAMS = {
  fromChain: 42161,
  toChain: 9745,
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
        toChain: 9745,
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

      const status = await bridge.getStatus('0xabc123', 42161, 9745);

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

      const status = await bridge.getStatus('0xabc123', 42161, 9745);
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

      const status = await bridge.getStatus('0xabc123', 42161, 9745);
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

      const status = await bridge.getStatus('0xabc123', 42161, 9745);
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

      const status = await bridge.getStatus('0xabc123', 42161, 9745);
      expect(status).to.deep.equal({ status: 'not_found' });
    });

    it('normalizes tx hash by adding 0x prefix', async () => {
      let calledUrl = '';
      sinon.stub(globalThis, 'fetch').callsFake(async (input) => {
        calledUrl = String(input);
        return makeResponse(createMockLZScanResponse('INFLIGHT'));
      });

      await bridge.getStatus('abc123', 42161, 9745);
      expect(calledUrl).to.include('/0xabc123');
    });
  });
});

describe('getRouteNetwork()', function () {
  it('returns native for ETH→Plasma', () => {
    expect(getRouteNetwork(1, 9745)).to.equal('native');
  });
  it('returns native for ETH→ARB (both available, native preferred)', () => {
    expect(getRouteNetwork(1, 42161)).to.equal('native');
  });
  it('returns legacy for ETH→Tron', () => {
    expect(getRouteNetwork(1, 728126428)).to.equal('legacy');
  });
  it('returns legacy for Tron→ETH', () => {
    expect(getRouteNetwork(728126428, 1)).to.equal('legacy');
  });
  it('returns legacy for ARB→Tron', () => {
    expect(getRouteNetwork(42161, 728126428)).to.equal('legacy');
  });
  it('returns null for BSC→ETH (unsupported)', () => {
    expect(getRouteNetwork(56, 1)).to.equal(null);
  });
});

describe('getOFTContractForRoute()', function () {
  it('returns native ETH OFT Adapter for ETH→ARB', () => {
    const r = getOFTContractForRoute(1, 42161);
    expect(r.network).to.equal('native');
    expect(r.address).to.equal('0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee');
  });
  it('returns legacy ETH OFT for ETH→Tron', () => {
    const r = getOFTContractForRoute(1, 728126428);
    expect(r.network).to.equal('legacy');
    expect(r.address).to.equal('0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0');
  });
  it('returns legacy Tron OFT for Tron→ETH', () => {
    const r = getOFTContractForRoute(728126428, 1);
    expect(r.network).to.equal('legacy');
    expect(r.address).to.equal('0x3a08f76772e200653bb55c2a92998daca62e0e97');
  });
  it('throws for unsupported route', () => {
    expect(() => getOFTContractForRoute(56, 1)).to.throw();
  });
});

describe('isSupportedRoute()', function () {
  it('supports ETH→Plasma (native)', () => {
    expect(isSupportedRoute(1, 9745)).to.be.true;
  });
  it('supports ETH→Tron (legacy)', () => {
    expect(isSupportedRoute(1, 728126428)).to.be.true;
  });
  it('supports Tron→ARB (legacy)', () => {
    expect(isSupportedRoute(728126428, 42161)).to.be.true;
  });
  it('does not support BSC→ETH', () => {
    expect(isSupportedRoute(56, 1)).to.be.false;
  });
});

// ── Compose route tests ────────────────────────────────────────────────────

import { getComposeHopContracts } from './layerZeroUtils.js';

describe('getRouteNetwork() — compose detection', function () {
  it('returns compose for Plasma → Tron (native-only → legacy-only)', () => {
    expect(getRouteNetwork(9745, 728126428)).to.equal('compose');
  });

  it('returns compose for Tron → Plasma (legacy-only → native-only)', () => {
    expect(getRouteNetwork(728126428, 9745)).to.equal('compose');
  });

  it('does NOT return compose for ETH → Tron (both in legacy)', () => {
    expect(getRouteNetwork(1, 728126428)).to.equal('legacy');
  });

  it('does NOT return compose for Plasma → ETH (both in native)', () => {
    expect(getRouteNetwork(9745, 1)).to.equal('native');
  });

  it('does NOT return compose for ETH → ARB (both in native and legacy)', () => {
    // native preferred over legacy
    expect(getRouteNetwork(1, 42161)).to.equal('native');
  });

  it('returns null for unsupported route (BSC → Plasma)', () => {
    expect(getRouteNetwork(56, 9745)).to.equal(null);
  });
});

describe('getComposeHopContracts()', function () {
  it('Plasma → Tron: firstHop = Plasma native OFT, secondHop = ARB Legacy Mesh OFT', () => {
    const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
      9745,
      728126428,
    );
    // Plasma native OFT
    expect(firstHopOFT).to.equal('0x02ca37966753bDdDf11216B73B16C1dE756A7CF9');
    // ARB Legacy Mesh OFT (reaches Tron)
    expect(secondHopOFT).to.equal('0x77652D5aba086137b595875263FC200182919B92');
  });

  it('Tron → Plasma: firstHop = Tron Legacy OFT, secondHop = ARB native OFT', () => {
    const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
      728126428,
      9745,
    );
    // Tron Legacy OFT
    expect(firstHopOFT).to.equal('0x3a08f76772e200653bb55c2a92998daca62e0e97');
    // ARB native OFT (reaches Plasma)
    expect(secondHopOFT).to.equal('0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92');
  });

  it('throws for unsupported route', () => {
    expect(() => getComposeHopContracts(56, 9745)).to.throw();
  });
});

describe('isSupportedRoute() — compose included', function () {
  it('supports Plasma → Tron (compose)', () => {
    expect(isSupportedRoute(9745, 728126428)).to.be.true;
  });

  it('supports Tron → Plasma (compose)', () => {
    expect(isSupportedRoute(728126428, 9745)).to.be.true;
  });

  it('does not support BSC → Plasma', () => {
    expect(isSupportedRoute(56, 9745)).to.be.false;
  });
});
