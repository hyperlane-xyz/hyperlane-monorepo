import { expect } from 'chai';
import sinon from 'sinon';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';
import { ethers } from 'ethers';

import type { ExternalBridgeConfig } from '../interfaces/IExternalBridge.js';
import { LayerZeroBridge } from './LayerZeroBridge.js';
import {
  ARB_HUB_EID,
  getRouteNetwork,
  getOFTContractForRoute,
  getUSDTAddress,
  getEID,
  SOLANA_CHAIN_ID,
  SOLANA_OFT_PROGRAM,
  TRON_CHAIN_ID,
  isSupportedRoute,
} from './layerZeroUtils.js';
import { getComposeHopContracts } from './layerZeroUtils.js';
import { solanaLayerZeroClient } from './layerZeroSolanaClient.js';
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
    tron: {
      chainId: TRON_CHAIN_ID,
      name: 'tron',
      domainId: TRON_CHAIN_ID,
      protocol: ProtocolType.Tron,
      rpcUrls: [{ http: 'https://tron-rpc.example.com' }],
    },
    plasma: {
      chainId: 9745,
      name: 'plasma',
      domainId: 9745,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://plasma-rpc.example.com' }],
    },
    solana: {
      chainId: SOLANA_CHAIN_ID,
      name: 'solana',
      domainId: SOLANA_CHAIN_ID,
      protocol: ProtocolType.Sealevel,
      rpcUrls: [{ http: 'https://solana-rpc.example.com' }],
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

    it('delegates Solana-origin quotes to the Solana client', async () => {
      const solanaQuoteStub = sinon
        .stub(solanaLayerZeroClient, 'quoteSolanaTransfer')
        .resolves({
          amountReceivedLd: 9997000n,
          feeCosts: 3000n,
          messagingFee: { nativeFee: 5000n, lzTokenFee: 0n },
        });

      const quote = await bridge.quote({
        fromChain: SOLANA_CHAIN_ID,
        toChain: 42161,
        fromToken: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        toToken: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        fromAmount: 10000000n,
        fromAddress: 'mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X',
      });

      expect(solanaQuoteStub.calledOnce).to.equal(true);
      expect(quote.route.kind).to.equal('solana');
      expect(quote.route.network).to.equal('legacy');
      expect(quote.toAmount).to.equal(9997000n);
    });

    it('rejects non-USDT fromToken params', async () => {
      let threw = false;
      try {
        await bridge.quote({
          ...BASE_PARAMS,
          fromToken: '0x1111111111111111111111111111111111111111',
          fromAmount: 10000000000n,
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.match(/USDT-only.*fromToken/i);
      }
      expect(threw).to.equal(true);
    });

    it('rejects non-USDT toToken params', async () => {
      let threw = false;
      try {
        await bridge.quote({
          ...BASE_PARAMS,
          toToken: '0x1111111111111111111111111111111111111111',
          fromAmount: 10000000000n,
        });
      } catch (error) {
        threw = true;
        expect((error as Error).message).to.match(/USDT-only.*toToken/i);
      }
      expect(threw).to.equal(true);
    });

    it('accepts mixed-case EVM USDT token params', async () => {
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
        fromToken: BASE_PARAMS.fromToken.toUpperCase(),
        toToken: BASE_PARAMS.toToken.toUpperCase(),
        fromAmount: 10000000000n,
      });

      expect(quote.tool).to.equal('layerzero');
      expect(quoteOFTStub.calledOnce).to.equal(true);
      expect(quoteSendStub.calledOnce).to.equal(true);
    });

    it('quotes non-Solana compose routes through the Arbitrum hub', async () => {
      const composeParams = {
        ...BASE_PARAMS,
        fromChain: TRON_CHAIN_ID,
        toChain: 9745,
        fromToken: getUSDTAddress(TRON_CHAIN_ID),
        toToken: getUSDTAddress(9745),
        fromAmount: 10000000000n,
      };
      const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
        composeParams.fromChain,
        composeParams.toChain,
      );
      const firstHopQuoteOFTStub = sinon.stub().callsFake((sendParam) => {
        expect(sendParam.dstEid).to.equal(ARB_HUB_EID);
        return Promise.resolve([
          createMockQuoteOFTResponse().oftLimit,
          createMockQuoteOFTResponse().oftFeeDetails,
          createMockQuoteOFTResponse().oftReceipt,
        ]);
      });
      const firstHopQuoteSendStub = sinon.stub().resolves([
        createMockQuoteSendResponse({
          nativeFee: 2222n,
        }),
      ]);
      const secondHopQuoteOFTStub = sinon.stub().resolves([
        createMockQuoteOFTResponse({
          oftFeeDetails: [],
          oftReceipt: {
            amountSentLD: 9997000000n,
            amountReceivedLD: 9997000000n,
          },
        }).oftLimit,
        [],
        {
          amountSentLD: 9997000000n,
          amountReceivedLD: 9997000000n,
        },
      ]);
      const secondHopQuoteSendStub = sinon.stub().resolves([
        createMockQuoteSendResponse({
          nativeFee: 1111n,
        }),
      ]);

      stubContractConstructor((address) => {
        if (address === firstHopOFT) {
          return {
            quoteOFT: firstHopQuoteOFTStub,
            quoteSend: firstHopQuoteSendStub,
          };
        }
        if (address === secondHopOFT) {
          return {
            quoteOFT: secondHopQuoteOFTStub,
            quoteSend: secondHopQuoteSendStub,
          };
        }
        throw new Error(`Unexpected contract address ${String(address)}`);
      });

      const quote = await bridge.quote(composeParams);

      expect(firstHopQuoteOFTStub.calledOnce).to.equal(true);
      expect(firstHopQuoteSendStub.calledOnce).to.equal(true);
      expect(secondHopQuoteOFTStub.calledOnce).to.equal(true);
      expect(secondHopQuoteSendStub.calledOnce).to.equal(true);
      expect(quote.route.network).to.equal('compose');
      expect(quote.route.kind).to.not.equal('solana');
      if (quote.route.kind === 'solana') {
        throw new Error('Expected EVM/Tron compose route');
      }
      expect(quote.route.sendParam.dstEid).to.equal(ARB_HUB_EID);
      expect(quote.toAmount).to.equal(9997000000n);
    });

    it('quotes compose second hop from the first-hop output for legacy-origin routes', async () => {
      const composeParams = {
        ...BASE_PARAMS,
        fromChain: TRON_CHAIN_ID,
        toChain: 9745,
        fromToken: getUSDTAddress(TRON_CHAIN_ID),
        toToken: getUSDTAddress(9745),
        fromAmount: 10000000000n,
      };
      const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
        composeParams.fromChain,
        composeParams.toChain,
      );
      const firstHopReceivedLD = 9997000000n;
      const secondHopReceivedLD = 9997000000n;
      const abiCoder = new ethers.utils.AbiCoder();

      const firstHopQuoteOFTStub = sinon.stub().resolves([
        createMockQuoteOFTResponse({
          oftReceipt: {
            amountSentLD: composeParams.fromAmount,
            amountReceivedLD: firstHopReceivedLD,
          },
        }).oftLimit,
        createMockQuoteOFTResponse().oftFeeDetails,
        {
          amountSentLD: composeParams.fromAmount,
          amountReceivedLD: firstHopReceivedLD,
        },
      ]);
      const firstHopQuoteSendStub = sinon.stub().resolves([
        createMockQuoteSendResponse({
          nativeFee: 1234n,
        }),
      ]);
      const secondHopQuoteOFTStub = sinon.stub().callsFake((sendParam) => {
        expect(sendParam.dstEid).to.equal(getEID(composeParams.toChain));
        expect(sendParam.amountLD).to.equal(firstHopReceivedLD);
        return Promise.resolve([
          createMockQuoteOFTResponse({
            oftFeeDetails: [],
            oftReceipt: {
              amountSentLD: firstHopReceivedLD,
              amountReceivedLD: secondHopReceivedLD,
            },
          }).oftLimit,
          [],
          {
            amountSentLD: firstHopReceivedLD,
            amountReceivedLD: secondHopReceivedLD,
          },
        ]);
      });
      const secondHopQuoteSendStub = sinon.stub().resolves([
        createMockQuoteSendResponse({
          nativeFee: 4321n,
        }),
      ]);

      stubContractConstructor((address) => {
        if (address === firstHopOFT) {
          return {
            quoteOFT: firstHopQuoteOFTStub,
            quoteSend: firstHopQuoteSendStub,
          };
        }
        if (address === secondHopOFT) {
          return {
            quoteOFT: secondHopQuoteOFTStub,
            quoteSend: secondHopQuoteSendStub,
          };
        }
        throw new Error(`Unexpected contract address ${String(address)}`);
      });

      const quote = await bridge.quote(composeParams);
      expect(quote.route.kind).to.not.equal('solana');
      if (quote.route.kind === 'solana') {
        throw new Error('Expected EVM/Tron compose route');
      }
      expect(quote.route.composeSendParam?.amountLD).to.equal(
        firstHopReceivedLD,
      );
      expect(quote.toAmount).to.equal(secondHopReceivedLD);

      const [decodedComposeSendParam] = abiCoder.decode(
        ['tuple(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)'],
        quote.route.sendParam.composeMsg,
      ) as [[number, string, bigint, bigint, string, string, string]];
      expect(BigInt(decodedComposeSendParam[2].toString())).to.equal(
        firstHopReceivedLD,
      );
      expect(BigInt(decodedComposeSendParam[3].toString())).to.equal(
        secondHopReceivedLD,
      );
    });

    it('quotes Solana compose second hop from the first-hop output', async () => {
      const firstHopReceivedLD = 9997000n;
      const secondHopReceivedLD = 9997000n;
      const abiCoder = new ethers.utils.AbiCoder();
      const solanaQuoteStub = sinon
        .stub(solanaLayerZeroClient, 'quoteSolanaTransfer')
        .onFirstCall()
        .resolves({
          amountReceivedLd: firstHopReceivedLD,
          feeCosts: 3000n,
          messagingFee: { nativeFee: 5000n, lzTokenFee: 0n },
        })
        .onSecondCall()
        .resolves({
          amountReceivedLd: firstHopReceivedLD,
          feeCosts: 3000n,
          messagingFee: { nativeFee: 7000n, lzTokenFee: 0n },
        });
      const { secondHopOFT } = getComposeHopContracts(SOLANA_CHAIN_ID, 9745);
      const secondHopQuoteOFTStub = sinon.stub().callsFake((sendParam) => {
        expect(sendParam.amountLD).to.equal(firstHopReceivedLD);
        return Promise.resolve([
          createMockQuoteOFTResponse({
            oftFeeDetails: [],
            oftReceipt: {
              amountSentLD: firstHopReceivedLD,
              amountReceivedLD: secondHopReceivedLD,
            },
          }).oftLimit,
          [],
          {
            amountSentLD: firstHopReceivedLD,
            amountReceivedLD: secondHopReceivedLD,
          },
        ]);
      });
      const secondHopQuoteSendStub = sinon.stub().resolves([
        createMockQuoteSendResponse({
          nativeFee: 2222n,
        }),
      ]);
      stubContractConstructor((address) => {
        if (address === secondHopOFT) {
          return {
            quoteOFT: secondHopQuoteOFTStub,
            quoteSend: secondHopQuoteSendStub,
          };
        }
        throw new Error(`Unexpected contract address ${String(address)}`);
      });

      const quote = await bridge.quote({
        fromChain: SOLANA_CHAIN_ID,
        toChain: 9745,
        fromToken: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        toToken: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
        fromAmount: 10000000n,
        fromAddress: 'mZhPGteS36G7FhMTcRofLQU8ocBNAsGq7u8SKSHfL2X',
      });

      expect(solanaQuoteStub.calledTwice).to.equal(true);
      expect(secondHopQuoteOFTStub.calledOnce).to.equal(true);
      expect(quote.toAmount).to.equal(secondHopReceivedLD);
      expect(quote.route.kind).to.equal('solana');
      if (quote.route.kind !== 'solana') {
        throw new Error('Expected Solana compose route');
      }

      const [decodedComposeSendParam] = abiCoder.decode(
        ['tuple(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)'],
        quote.route.composeMsgHex,
      ) as [[number, string, bigint, bigint, string, string, string]];
      expect(BigInt(decodedComposeSendParam[2].toString())).to.equal(
        firstHopReceivedLD,
      );
      expect(BigInt(decodedComposeSendParam[3].toString())).to.equal(
        secondHopReceivedLD,
      );
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

    it('delegates Solana-origin execution to the Solana client', async () => {
      const quote = createMockLayerZeroQuote({
        route: {
          kind: 'solana',
          fromChainId: SOLANA_CHAIN_ID,
          toChainId: 42161,
          network: 'legacy',
          programId: SOLANA_OFT_PROGRAM,
          store: 'HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN',
          tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          destinationEid: 30110,
          toBytes32:
            '0x0b6a86806a0354c82b8f049eb75d9c97e370a6f0c0cfa15f47909c3fe1c8f794',
          amountLd: 10000000n,
          minAmountLd: 9997000n,
          extraOptionsHex: '0x',
          composeMsgHex: '0x',
          nativeFeeLamports: 5000n,
          lzTokenFee: 0n,
        },
      });
      const executeStub = sinon
        .stub(solanaLayerZeroClient, 'executeSolanaTransfer')
        .resolves('5YxNQ4fakeSig');

      const result = await bridge.execute(quote, {
        [ProtocolType.Sealevel]:
          '1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1',
      });

      expect(executeStub.calledOnce).to.equal(true);
      expect(result).to.deep.equal({
        txHash: '5YxNQ4fakeSig',
        fromChain: SOLANA_CHAIN_ID,
        toChain: 42161,
      });
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
    expect(getRouteNetwork(1, TRON_CHAIN_ID)).to.equal('legacy');
  });
  it('returns legacy for Tron→ETH', () => {
    expect(getRouteNetwork(TRON_CHAIN_ID, 1)).to.equal('legacy');
  });
  it('returns legacy for ARB→Tron', () => {
    expect(getRouteNetwork(42161, TRON_CHAIN_ID)).to.equal('legacy');
  });
  it('returns legacy for Solana→ARB', () => {
    expect(getRouteNetwork(SOLANA_CHAIN_ID, 42161)).to.equal('legacy');
  });
  it('returns compose for Solana→Plasma', () => {
    expect(getRouteNetwork(SOLANA_CHAIN_ID, 9745)).to.equal('compose');
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
    const r = getOFTContractForRoute(1, TRON_CHAIN_ID);
    expect(r.network).to.equal('legacy');
    expect(r.address).to.equal('0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0');
  });
  it('returns legacy Tron OFT for Tron→ETH', () => {
    const r = getOFTContractForRoute(TRON_CHAIN_ID, 1);
    expect(r.network).to.equal('legacy');
    expect(r.address).to.equal('0x3a08f76772e200653bb55c2a92998daca62e0e97');
  });
  it('returns Solana OFT program for Solana→ETH', () => {
    const r = getOFTContractForRoute(SOLANA_CHAIN_ID, 1);
    expect(r.network).to.equal('legacy');
    expect(r.address).to.equal(SOLANA_OFT_PROGRAM);
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
    expect(isSupportedRoute(1, TRON_CHAIN_ID)).to.be.true;
  });
  it('supports Tron→ARB (legacy)', () => {
    expect(isSupportedRoute(TRON_CHAIN_ID, 42161)).to.be.true;
  });
  it('supports Solana→ARB (legacy)', () => {
    expect(isSupportedRoute(SOLANA_CHAIN_ID, 42161)).to.be.true;
  });
  it('does not support BSC→ETH', () => {
    expect(isSupportedRoute(56, 1)).to.be.false;
  });
});

describe('getRouteNetwork() — compose detection', function () {
  it('returns compose for Plasma → Tron (native-only → legacy-only)', () => {
    expect(getRouteNetwork(9745, TRON_CHAIN_ID)).to.equal('compose');
  });

  it('returns compose for Tron → Plasma (legacy-only → native-only)', () => {
    expect(getRouteNetwork(TRON_CHAIN_ID, 9745)).to.equal('compose');
  });

  it('returns compose for Plasma → Solana (native-only → legacy-only)', () => {
    expect(getRouteNetwork(9745, SOLANA_CHAIN_ID)).to.equal('compose');
  });

  it('does NOT return compose for ETH → Tron (both in legacy)', () => {
    expect(getRouteNetwork(1, TRON_CHAIN_ID)).to.equal('legacy');
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
      TRON_CHAIN_ID,
    );
    // Plasma native OFT
    expect(firstHopOFT).to.equal('0x02ca37966753bDdDf11216B73B16C1dE756A7CF9');
    // ARB Legacy Mesh OFT (reaches Tron)
    expect(secondHopOFT).to.equal('0x77652D5aba086137b595875263FC200182919B92');
  });

  it('Tron → Plasma: firstHop = Tron Legacy OFT, secondHop = ARB native OFT', () => {
    const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
      TRON_CHAIN_ID,
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

  it('Solana → Plasma: firstHop = Solana OFT, secondHop = ARB native OFT', () => {
    const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
      SOLANA_CHAIN_ID,
      9745,
    );
    expect(firstHopOFT).to.equal(SOLANA_OFT_PROGRAM);
    expect(secondHopOFT).to.equal('0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92');
  });

  it('Plasma → Solana: firstHop = Plasma native OFT, secondHop = ARB Legacy Mesh OFT', () => {
    const { firstHopOFT, secondHopOFT } = getComposeHopContracts(
      9745,
      SOLANA_CHAIN_ID,
    );
    expect(firstHopOFT).to.equal('0x02ca37966753bDdDf11216B73B16C1dE756A7CF9');
    expect(secondHopOFT).to.equal('0x77652D5aba086137b595875263FC200182919B92');
  });
});

describe('isSupportedRoute() — compose included', function () {
  it('supports Plasma → Tron (compose)', () => {
    expect(isSupportedRoute(9745, TRON_CHAIN_ID)).to.be.true;
  });

  it('supports Tron → Plasma (compose)', () => {
    expect(isSupportedRoute(TRON_CHAIN_ID, 9745)).to.be.true;
  });

  it('supports Plasma → Solana (compose)', () => {
    expect(isSupportedRoute(9745, SOLANA_CHAIN_ID)).to.be.true;
  });

  it('does not support BSC → Plasma', () => {
    expect(isSupportedRoute(56, 9745)).to.be.false;
  });
});
