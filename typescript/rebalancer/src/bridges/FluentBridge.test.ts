import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ExternalBridgeConfig } from '../interfaces/IExternalBridge.js';
import { FluentBridge } from './FluentBridge.js';
import {
  ETHEREUM_CHAIN_ID,
  FLUENT_BRIDGE_ADDRESS,
  FLUENT_CHAIN_ID,
  FLUENT_NATIVE_GATEWAY_ADDRESS,
  MessageStatus,
  NATIVE_TOKEN_SENTINEL,
  fluentBridgeInterface,
} from './fluentUtils.js';

const testLogger = pino({ level: 'silent' });
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);
const TEST_MESSAGE_HASH = ethers.utils.hexZeroPad('0xabcd', 32);

const BRIDGE_CONFIG: ExternalBridgeConfig = {
  integrator: 'hyperlane',
  chainMetadata: {
    ethereum: {
      chainId: ETHEREUM_CHAIN_ID,
      domainId: ETHEREUM_CHAIN_ID,
      protocol: ProtocolType.Ethereum,
      name: 'ethereum',
      displayName: 'Ethereum',
      rpcUrls: [{ http: 'https://ethereum.example' }],
    },
    fluent: {
      chainId: FLUENT_CHAIN_ID,
      domainId: FLUENT_CHAIN_ID,
      protocol: ProtocolType.Ethereum,
      name: 'fluent',
      displayName: 'Fluent',
      rpcUrls: [{ http: 'https://fluent.example' }],
    },
  },
};

class TestFluentBridge extends FluentBridge {
  messageFeeByChain = new Map<number, bigint>();
  messageStatusByHash = new Map<string, number>();
  currentBlockByChain = new Map<number, number>();
  receiptResponses = new Map<
    string,
    ethers.providers.TransactionReceipt | null
  >();
  transactionDetails = new Map<
    string,
    ethers.providers.TransactionResponse | null
  >();
  sentTransactions: Array<{ chainId: number; tx: any }> = [];
  nextReceipts: ethers.providers.TransactionReceipt[] = [];

  protected override async readContract(
    chainId: number,
    to: string,
    data: string,
  ): Promise<string> {
    if (
      to.toLowerCase() === FLUENT_BRIDGE_ADDRESS.toLowerCase() &&
      data.startsWith(fluentBridgeInterface.getSighash('getSentMessageFee'))
    ) {
      const fee = this.messageFeeByChain.get(chainId) ?? 0n;
      return fluentBridgeInterface.encodeFunctionResult('getSentMessageFee', [
        fee,
      ]);
    }
    if (
      to.toLowerCase() === FLUENT_BRIDGE_ADDRESS.toLowerCase() &&
      data.startsWith(fluentBridgeInterface.getSighash('getReceivedMessage'))
    ) {
      const decoded = fluentBridgeInterface.decodeFunctionData(
        'getReceivedMessage',
        data,
      );
      const status =
        this.messageStatusByHash.get(decoded[0] as string) ??
        MessageStatus.None;
      return fluentBridgeInterface.encodeFunctionResult('getReceivedMessage', [
        status,
      ]);
    }
    throw new Error(`Unexpected readContract call: ${to} ${data}`);
  }

  protected override async getCurrentBlockNumber(
    chainId: number,
  ): Promise<number> {
    return this.currentBlockByChain.get(chainId) ?? 1_000_000;
  }

  protected override async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionReceipt | null> {
    return (
      this.receiptResponses.get(`${chainId}:${txHash.toLowerCase()}`) ?? null
    );
  }

  protected override async getTransaction(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionResponse | null> {
    return (
      this.transactionDetails.get(`${chainId}:${txHash.toLowerCase()}`) ?? null
    );
  }

  protected override async sendPreparedTransaction(
    chainId: number,
    _privateKey: string,
    tx: any,
  ): Promise<ethers.providers.TransactionReceipt> {
    this.sentTransactions.push({ chainId, tx });
    const receipt = this.nextReceipts.shift();
    if (!receipt) throw new Error('Missing test receipt');
    return receipt;
  }
}

function createSentMessageReceipt(
  txHash: string,
  messageHash: string,
): ethers.providers.TransactionReceipt {
  const encoded = fluentBridgeInterface.encodeEventLog(
    fluentBridgeInterface.getEvent('SentMessage'),
    [
      TEST_WALLET.address,
      FLUENT_NATIVE_GATEWAY_ADDRESS,
      1_000_000_000_000_000n,
      0n,
      ETHEREUM_CHAIN_ID,
      1_000_500,
      42,
      messageHash,
      '0xb9cca7a3',
    ],
  );
  return {
    transactionHash: txHash,
    logs: [
      {
        address: FLUENT_BRIDGE_ADDRESS,
        topics: encoded.topics,
        data: encoded.data,
        transactionHash: txHash,
      } as ethers.providers.Log,
    ],
  } as ethers.providers.TransactionReceipt;
}

describe('FluentBridge', () => {
  describe('quote', () => {
    it('quotes ethereum -> fluent at 1:1 with on-chain message fee', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      bridge.messageFeeByChain.set(ETHEREUM_CHAIN_ID, 0n);

      const quote = await bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: FLUENT_CHAIN_ID,
        fromToken: NATIVE_TOKEN_SENTINEL,
        toToken: NATIVE_TOKEN_SENTINEL,
        fromAmount: 1_000_000_000_000_000n,
        fromAddress: TEST_WALLET.address,
        toAddress: TEST_WALLET.address,
      });

      expect(quote.tool).to.equal('fluent');
      expect(quote.fromAmount).to.equal(1_000_000_000_000_000n);
      expect(quote.toAmount).to.equal(1_000_000_000_000_000n);
      expect(quote.toAmountMin).to.equal(1_000_000_000_000_000n);
      expect(quote.gasCosts).to.equal(0n);
      expect(quote.feeCosts).to.equal(0n);
      expect(quote.route.kind).to.equal('ethereum-to-fluent');
      expect(quote.route.executionTx.chainId).to.equal(ETHEREUM_CHAIN_ID);
      expect(quote.route.executionTx.value).to.equal(1_000_000_000_000_000n);
      expect(quote.route.executionTx.to.toLowerCase()).to.equal(
        FLUENT_NATIVE_GATEWAY_ADDRESS.toLowerCase(),
      );
    });

    it('quotes fluent -> ethereum and includes the L2 fee in tx value', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      bridge.messageFeeByChain.set(FLUENT_CHAIN_ID, 449_828_643_600_000n);

      const quote = await bridge.quote({
        fromChain: FLUENT_CHAIN_ID,
        toChain: ETHEREUM_CHAIN_ID,
        fromToken: NATIVE_TOKEN_SENTINEL,
        toToken: NATIVE_TOKEN_SENTINEL,
        fromAmount: 200_000_000_000_000n,
        fromAddress: TEST_WALLET.address,
        toAddress: TEST_WALLET.address,
      });

      expect(quote.gasCosts).to.equal(449_828_643_600_000n);
      expect(quote.route.kind).to.equal('fluent-to-ethereum');
      expect(quote.route.executionTx.chainId).to.equal(FLUENT_CHAIN_ID);
      expect(quote.route.executionTx.value).to.equal(
        200_000_000_000_000n + 449_828_643_600_000n,
      );
    });

    it('rejects an unsupported chain pair', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      let error: unknown;
      try {
        await bridge.quote({
          fromChain: 137,
          toChain: FLUENT_CHAIN_ID,
          fromToken: NATIVE_TOKEN_SENTINEL,
          toToken: NATIVE_TOKEN_SENTINEL,
          fromAmount: 1n,
          fromAddress: TEST_WALLET.address,
        });
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).to.match(/Unsupported Fluent route/);
    });
  });

  describe('execute', () => {
    it('sends sendNativeTokens and stores execution state keyed on tx hash', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      bridge.messageFeeByChain.set(ETHEREUM_CHAIN_ID, 0n);
      bridge.currentBlockByChain.set(FLUENT_CHAIN_ID, 1_000_000);
      bridge.nextReceipts = [
        createSentMessageReceipt('0xsourcetx', TEST_MESSAGE_HASH),
      ];

      const quote = await bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: FLUENT_CHAIN_ID,
        fromToken: NATIVE_TOKEN_SENTINEL,
        toToken: NATIVE_TOKEN_SENTINEL,
        fromAmount: 1_000_000_000_000_000n,
        fromAddress: TEST_WALLET.address,
        toAddress: TEST_WALLET.address,
      });

      const result = await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      });

      expect(result.txHash).to.equal('0xsourcetx');
      expect(result.transferId).to.equal(TEST_MESSAGE_HASH);
      expect(result.fromChain).to.equal(ETHEREUM_CHAIN_ID);
      expect(result.toChain).to.equal(FLUENT_CHAIN_ID);
      expect(bridge.sentTransactions).to.have.length(1);
      expect(bridge.sentTransactions[0].chainId).to.equal(ETHEREUM_CHAIN_ID);
    });

    it('throws if the source receipt is missing a SentMessage event', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      bridge.messageFeeByChain.set(ETHEREUM_CHAIN_ID, 0n);
      bridge.nextReceipts = [
        { transactionHash: '0xsourcetx', logs: [] } as any,
      ];

      const quote = await bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: FLUENT_CHAIN_ID,
        fromToken: NATIVE_TOKEN_SENTINEL,
        toToken: NATIVE_TOKEN_SENTINEL,
        fromAmount: 1_000_000_000_000_000n,
        fromAddress: TEST_WALLET.address,
        toAddress: TEST_WALLET.address,
      });

      let error: unknown;
      try {
        await bridge.execute(quote, {
          [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
        });
      } catch (e) {
        error = e;
      }
      expect((error as Error).message).to.match(/SentMessage/);
    });
  });

  describe('getStatus', () => {
    async function setUpExecutedQuote(bridge: TestFluentBridge) {
      bridge.messageFeeByChain.set(ETHEREUM_CHAIN_ID, 0n);
      bridge.currentBlockByChain.set(FLUENT_CHAIN_ID, 1_000_000);
      bridge.nextReceipts = [
        createSentMessageReceipt('0xsourcetx', TEST_MESSAGE_HASH),
      ];
      const quote = await bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: FLUENT_CHAIN_ID,
        fromToken: NATIVE_TOKEN_SENTINEL,
        toToken: NATIVE_TOKEN_SENTINEL,
        fromAmount: 1_000_000_000_000_000n,
        fromAddress: TEST_WALLET.address,
        toAddress: TEST_WALLET.address,
      });
      await bridge.execute(quote, {
        [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
      });
    }

    it('returns pending IN_FLIGHT when destination status is None', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      await setUpExecutedQuote(bridge);

      const status = await bridge.getStatus(
        '0xsourcetx',
        ETHEREUM_CHAIN_ID,
        FLUENT_CHAIN_ID,
      );
      expect(status).to.deep.equal({
        status: 'pending',
        substatus: 'IN_FLIGHT',
      });
    });

    it('returns failed when destination status is Failed', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      await setUpExecutedQuote(bridge);
      bridge.messageStatusByHash.set(TEST_MESSAGE_HASH, MessageStatus.Failed);

      const status = await bridge.getStatus(
        '0xsourcetx',
        ETHEREUM_CHAIN_ID,
        FLUENT_CHAIN_ID,
      );
      expect(status.status).to.equal('failed');
    });

    it('returns complete with receivedAmount derived from quote when destination status is Success', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      await setUpExecutedQuote(bridge);
      bridge.messageStatusByHash.set(TEST_MESSAGE_HASH, MessageStatus.Success);

      const status = await bridge.getStatus(
        '0xsourcetx',
        ETHEREUM_CHAIN_ID,
        FLUENT_CHAIN_ID,
      );

      expect(status).to.deep.equal({
        status: 'complete',
        receivedAmount: 1_000_000_000_000_000n,
      });
    });

    it('returns not_found when the tx hash is unknown and not on-chain', async () => {
      const bridge = new TestFluentBridge(BRIDGE_CONFIG, testLogger);
      const status = await bridge.getStatus(
        '0xunknowntx',
        ETHEREUM_CHAIN_ID,
        FLUENT_CHAIN_ID,
      );
      expect(status.status).to.equal('not_found');
    });
  });

  describe('getNativeTokenAddress', () => {
    it('returns the zero-address sentinel', () => {
      const bridge = new FluentBridge(BRIDGE_CONFIG, testLogger);
      expect(bridge.getNativeTokenAddress()).to.equal(NATIVE_TOKEN_SENTINEL);
    });
  });
});
