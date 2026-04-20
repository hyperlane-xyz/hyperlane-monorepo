import { expect } from 'chai';
import { ethers } from 'ethers';
import { pino } from 'pino';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  ExternalBridgeConfig,
} from '../interfaces/IExternalBridge.js';
import { KatanaBridge, type KatanaBridgeRoute } from './KatanaBridge.js';
import {
  ETHEREUM_CHAIN_ID,
  KATANA_CHAIN_ID,
  KATANA_FORWARD_CONFIG,
  KATANA_REVERSE_CONFIG,
  applySlippage,
  buildKatanaEthereumToKatana,
  buildKatanaToEthereumCompose,
  composerInterface,
  oftInterface,
  previewInterface,
  type BuiltTx,
} from './katanaUtils.js';

const testLogger = pino({ level: 'silent' });
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);

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
    katana: {
      chainId: KATANA_CHAIN_ID,
      domainId: KATANA_CHAIN_ID,
      protocol: ProtocolType.Ethereum,
      name: 'katana',
      displayName: 'Katana',
      rpcUrls: [{ http: 'https://katana.example' }],
    },
  },
};

class TestKatanaBridge extends KatanaBridge {
  readonly callResults = new Map<string, string>();
  readonly sentCalls: Array<{ chainId: number; key: string; call: BuiltTx }> =
    [];
  readonly receipts = new Map<string, ethers.providers.TransactionReceipt>();
  nextReceipts: ethers.providers.TransactionReceipt[] = [];
  nextFetchResponse = new Response(JSON.stringify({ messages: [] }), {
    status: 200,
  });
  allowance = 0n;

  setCallResult(
    chainId: number,
    to: string,
    data: string,
    result: string,
  ): void {
    this.callResults.set(`${chainId}:${to.toLowerCase()}:${data}`, result);
  }

  setReceipt(
    chainId: number,
    txHash: string,
    receipt: ethers.providers.TransactionReceipt,
  ): void {
    this.receipts.set(`${chainId}:${txHash.toLowerCase()}`, receipt);
  }

  protected override async callContract(
    chainId: number,
    to: string,
    data: string,
  ): Promise<string> {
    const key = `${chainId}:${to.toLowerCase()}:${data}`;
    const result = this.callResults.get(key);
    if (!result) {
      throw new Error(`Missing test call result for ${key}`);
    }
    return result;
  }

  protected override async readAllowance(
    _chainId: number,
    _tokenAddress: string,
    _owner: string,
    _spender: string,
  ): Promise<bigint> {
    return this.allowance;
  }

  protected override async sendPreparedTransaction(
    chainId: number,
    key: string,
    call: BuiltTx,
  ): Promise<ethers.providers.TransactionReceipt> {
    this.sentCalls.push({ chainId, key, call });
    const receipt = this.nextReceipts.shift();
    if (!receipt) {
      throw new Error('Missing next test receipt');
    }
    return receipt;
  }

  protected override async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionReceipt | undefined> {
    return this.receipts.get(`${chainId}:${txHash.toLowerCase()}`);
  }

  protected override async fetchWithRetry(
    _url: string,
    _options?: RequestInit,
    _retries?: number,
  ): Promise<Response> {
    return this.nextFetchResponse;
  }
}

function createReceipt(
  transactionHash: string,
  logs: ethers.providers.Log[],
): ethers.providers.TransactionReceipt {
  return {
    transactionHash,
    logs,
  } as ethers.providers.TransactionReceipt;
}

function createEventLog(
  address: string,
  iface: ethers.utils.Interface,
  eventName: string,
  args: unknown[],
): ethers.providers.Log {
  const event = iface.getEvent(eventName);
  const encoded = iface.encodeEventLog(event, args);
  return {
    address,
    data: encoded.data,
    topics: encoded.topics,
  } as ethers.providers.Log;
}

function encodePreviewResult(
  functionName: 'previewDeposit' | 'previewRedeem',
  amount: bigint,
): string {
  return previewInterface.encodeFunctionResult(functionName, [amount]);
}

function encodeQuoteSendResult(
  nativeFee: bigint,
  lzTokenFee: bigint = 0n,
): string {
  return oftInterface.encodeFunctionResult('quoteSend', [
    [nativeFee, lzTokenFee],
  ]);
}

function encodeSecondaryChainBalanceResult(amount: bigint): string {
  const localInterface = new ethers.utils.Interface([
    'function secondaryChainBalance() view returns (uint256)',
  ]);
  return localInterface.encodeFunctionResult('secondaryChainBalance', [amount]);
}

function createForwardQuote(
  route: KatanaBridgeRoute,
): BridgeQuote<KatanaBridgeRoute> {
  const requestParams: BridgeQuoteParams = {
    fromChain: ETHEREUM_CHAIN_ID,
    toChain: KATANA_CHAIN_ID,
    fromToken: KATANA_FORWARD_CONFIG.fromToken,
    toToken: KATANA_FORWARD_CONFIG.toToken,
    fromAmount: 1_000_000n,
    fromAddress: TEST_WALLET.address,
    toAddress: TEST_WALLET.address,
  };

  return {
    id: 'quote-forward',
    tool: 'katana-vault-bridge',
    fromAmount: requestParams.fromAmount!,
    toAmount: route.previewAmount,
    toAmountMin: route.sendParam.minAmountLD,
    executionDuration: 120,
    gasCosts: route.nativeFee,
    feeCosts: 0n,
    route,
    requestParams,
  };
}

describe('KatanaBridge.quote()', () => {
  it('builds exact ethereum->katana calldata from previewDeposit + quoteSend', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    const recipient = TEST_WALLET.address;
    const fromAmount = 1_000_000n;
    const previewShares = 999_500n;
    const nativeFee = 123_456n;

    const previewData = previewInterface.encodeFunctionData('previewDeposit', [
      fromAmount.toString(),
    ]);
    bridge.setCallResult(
      ETHEREUM_CHAIN_ID,
      KATANA_FORWARD_CONFIG.vaultAddress,
      previewData,
      encodePreviewResult('previewDeposit', previewShares),
    );

    const exactCall = buildKatanaEthereumToKatana({
      vaultAddress: KATANA_FORWARD_CONFIG.vaultAddress,
      composerAddress: KATANA_FORWARD_CONFIG.composerAddress,
      shareOftAddress: KATANA_FORWARD_CONFIG.shareOftAddress,
      underlyingTokenAddress: KATANA_FORWARD_CONFIG.fromToken,
      dstEid: KATANA_FORWARD_CONFIG.dstEid,
      recipient,
      amountLD: fromAmount,
      shareAmountLD: previewShares,
      minShareAmountLD: applySlippage(previewShares, 0.005),
      refundAddress: TEST_WALLET.address,
      extraOptions: KATANA_FORWARD_CONFIG.extraOptions,
      composeMsg: KATANA_FORWARD_CONFIG.composeMsg,
      oftCmd: KATANA_FORWARD_CONFIG.oftCmd,
    });
    bridge.setCallResult(
      ETHEREUM_CHAIN_ID,
      exactCall.quoteRead.to,
      exactCall.quoteRead.data,
      encodeQuoteSendResult(nativeFee),
    );

    const quote = await bridge.quote({
      fromChain: ETHEREUM_CHAIN_ID,
      toChain: KATANA_CHAIN_ID,
      fromToken: KATANA_FORWARD_CONFIG.fromToken,
      toToken: KATANA_FORWARD_CONFIG.toToken,
      fromAmount,
      fromAddress: TEST_WALLET.address,
      toAddress: recipient,
    });

    expect(quote.toAmount).to.equal(previewShares);
    expect(quote.toAmountMin).to.equal(applySlippage(previewShares, 0.005));
    expect(quote.gasCosts).to.equal(nativeFee);
    expect(quote.route.executionCall.value).to.equal(nativeFee);
    expect(quote.route.executionCall.data).to.equal(
      exactCall.depositAndSendTx.data,
    );
    expect(quote.route.sendParam.amountLD).to.equal(previewShares);
  });

  it('builds exact katana->ethereum calldata from previewRedeem + quoteSend', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    const shareAmount = 1_000_000n;
    const previewAssets = 998_000n;
    const nativeFee = 456_789n;

    const previewData = previewInterface.encodeFunctionData('previewRedeem', [
      shareAmount.toString(),
    ]);
    bridge.setCallResult(
      ETHEREUM_CHAIN_ID,
      KATANA_REVERSE_CONFIG.vaultAddress,
      previewData,
      encodePreviewResult('previewRedeem', previewAssets),
    );

    const exactCall = buildKatanaToEthereumCompose({
      vaultAddress: KATANA_REVERSE_CONFIG.vaultAddress,
      composerAddress: KATANA_REVERSE_CONFIG.composerAddress,
      shareTokenAddress: KATANA_REVERSE_CONFIG.shareTokenAddress,
      shareOftAddress: KATANA_REVERSE_CONFIG.shareOftAddress,
      dstEid: KATANA_REVERSE_CONFIG.dstEid,
      recipient: TEST_WALLET.address,
      shareAmountLD: shareAmount,
      minShareAmountLD: shareAmount,
      assetAmountLD: previewAssets,
      minAssetAmountLD: applySlippage(previewAssets, 0.005),
      refundAddress: TEST_WALLET.address,
      extraOptions: KATANA_REVERSE_CONFIG.extraOptions,
      receiveExtraOptions: KATANA_REVERSE_CONFIG.receiveExtraOptions,
      oftCmd: KATANA_REVERSE_CONFIG.oftCmd,
    });
    bridge.setCallResult(
      KATANA_CHAIN_ID,
      exactCall.quoteRead.to,
      exactCall.quoteRead.data,
      encodeQuoteSendResult(nativeFee),
    );
    bridge.setCallResult(
      KATANA_CHAIN_ID,
      KATANA_REVERSE_CONFIG.shareOftAddress,
      oftInterface.encodeFunctionData('secondaryChainBalance', []),
      encodeSecondaryChainBalanceResult(2_000_000n),
    );

    const quote = await bridge.quote({
      fromChain: KATANA_CHAIN_ID,
      toChain: ETHEREUM_CHAIN_ID,
      fromToken: KATANA_REVERSE_CONFIG.fromToken,
      toToken: KATANA_REVERSE_CONFIG.toToken,
      fromAmount: shareAmount,
      fromAddress: TEST_WALLET.address,
      toAddress: TEST_WALLET.address,
    });

    expect(quote.toAmount).to.equal(previewAssets);
    expect(quote.toAmountMin).to.equal(applySlippage(previewAssets, 0.005));
    expect(quote.gasCosts).to.equal(nativeFee);
    expect(quote.route.executionCall.value).to.equal(nativeFee);
    expect(quote.route.executionCall.data).to.equal(
      oftInterface.encodeFunctionData('send', [
        exactCall.sendParam,
        { nativeFee, lzTokenFee: 0 },
        TEST_WALLET.address,
      ]),
    );
  });

  it('rejects unsupported toAmount quotes', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    try {
      await bridge.quote({
        fromChain: ETHEREUM_CHAIN_ID,
        toChain: KATANA_CHAIN_ID,
        fromToken: KATANA_FORWARD_CONFIG.fromToken,
        toToken: KATANA_FORWARD_CONFIG.toToken,
        toAmount: 1n,
        fromAddress: TEST_WALLET.address,
      });
      expect.fail('Expected quote to reject');
    } catch (error) {
      expect((error as Error).message).to.include('does not support toAmount');
    }
  });

  it('rejects reverse quotes when secondaryChainBalance is insufficient', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    const shareAmount = 1_000_000n;
    const previewData = previewInterface.encodeFunctionData('previewRedeem', [
      shareAmount.toString(),
    ]);
    bridge.setCallResult(
      ETHEREUM_CHAIN_ID,
      KATANA_REVERSE_CONFIG.vaultAddress,
      previewData,
      encodePreviewResult('previewRedeem', 999_000n),
    );

    const exactCall = buildKatanaToEthereumCompose({
      vaultAddress: KATANA_REVERSE_CONFIG.vaultAddress,
      composerAddress: KATANA_REVERSE_CONFIG.composerAddress,
      shareTokenAddress: KATANA_REVERSE_CONFIG.shareTokenAddress,
      shareOftAddress: KATANA_REVERSE_CONFIG.shareOftAddress,
      dstEid: KATANA_REVERSE_CONFIG.dstEid,
      recipient: TEST_WALLET.address,
      shareAmountLD: shareAmount,
      minShareAmountLD: shareAmount,
      assetAmountLD: 999_000n,
      minAssetAmountLD: applySlippage(999_000n, 0.005),
      refundAddress: TEST_WALLET.address,
      extraOptions: KATANA_REVERSE_CONFIG.extraOptions,
      receiveExtraOptions: KATANA_REVERSE_CONFIG.receiveExtraOptions,
      oftCmd: KATANA_REVERSE_CONFIG.oftCmd,
    });
    bridge.setCallResult(
      KATANA_CHAIN_ID,
      exactCall.quoteRead.to,
      exactCall.quoteRead.data,
      encodeQuoteSendResult(1n),
    );
    bridge.setCallResult(
      KATANA_CHAIN_ID,
      KATANA_REVERSE_CONFIG.shareOftAddress,
      oftInterface.encodeFunctionData('secondaryChainBalance', []),
      encodeSecondaryChainBalanceResult(999_999n),
    );

    try {
      await bridge.quote({
        fromChain: KATANA_CHAIN_ID,
        toChain: ETHEREUM_CHAIN_ID,
        fromToken: KATANA_REVERSE_CONFIG.fromToken,
        toToken: KATANA_REVERSE_CONFIG.toToken,
        fromAmount: shareAmount,
        fromAddress: TEST_WALLET.address,
      });
      expect.fail('Expected quote to reject');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Insufficient Katana secondaryChainBalance',
      );
    }
  });
});

describe('KatanaBridge.execute()', () => {
  it('sends approval then execution and extracts the guid', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    const guid =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const exactCall = buildKatanaEthereumToKatana({
      vaultAddress: KATANA_FORWARD_CONFIG.vaultAddress,
      composerAddress: KATANA_FORWARD_CONFIG.composerAddress,
      shareOftAddress: KATANA_FORWARD_CONFIG.shareOftAddress,
      underlyingTokenAddress: KATANA_FORWARD_CONFIG.fromToken,
      dstEid: KATANA_FORWARD_CONFIG.dstEid,
      recipient: TEST_WALLET.address,
      amountLD: 1_000_000n,
      shareAmountLD: 999_000n,
      minShareAmountLD: 998_000n,
      refundAddress: TEST_WALLET.address,
      extraOptions: KATANA_FORWARD_CONFIG.extraOptions,
      composeMsg: KATANA_FORWARD_CONFIG.composeMsg,
      oftCmd: KATANA_FORWARD_CONFIG.oftCmd,
    });
    const route: KatanaBridgeRoute = {
      kind: 'ethereum-to-katana',
      fromChainId: ETHEREUM_CHAIN_ID,
      toChainId: KATANA_CHAIN_ID,
      fromToken: KATANA_FORWARD_CONFIG.fromToken,
      toToken: KATANA_FORWARD_CONFIG.toToken,
      recipient: TEST_WALLET.address,
      refundAddress: TEST_WALLET.address,
      previewAmount: 999_000n,
      nativeFee: 123n,
      sendParam: exactCall.sendParam,
      quoteRead: exactCall.quoteRead,
      approvalCall: exactCall.assetApproveTx,
      executionCall: { ...exactCall.depositAndSendTx, value: 123n },
    };
    const quote = createForwardQuote(route);

    bridge.allowance = 0n;
    bridge.nextReceipts = [
      createReceipt('0xapprove', []),
      createReceipt('0xexecute', [
        createEventLog(route.executionCall.to, oftInterface, 'OFTSent', [
          guid,
          KATANA_FORWARD_CONFIG.dstEid,
          TEST_WALLET.address,
          999_000n,
          999_000n,
        ]),
      ]),
    ];

    const result = await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(result.txHash).to.equal('0xexecute');
    expect(result.transferId).to.equal(guid);
    expect(bridge.sentCalls).to.have.length(2);
    expect(bridge.sentCalls[0].call.data).to.equal(route.approvalCall.data);
    expect(bridge.sentCalls[1].call.data).to.equal(route.executionCall.data);
    expect(bridge.sentCalls[1].call.value).to.equal(123n);
  });

  it('skips approval when allowance is sufficient', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    const exactCall = buildKatanaEthereumToKatana({
      vaultAddress: KATANA_FORWARD_CONFIG.vaultAddress,
      composerAddress: KATANA_FORWARD_CONFIG.composerAddress,
      shareOftAddress: KATANA_FORWARD_CONFIG.shareOftAddress,
      underlyingTokenAddress: KATANA_FORWARD_CONFIG.fromToken,
      dstEid: KATANA_FORWARD_CONFIG.dstEid,
      recipient: TEST_WALLET.address,
      amountLD: 1_000_000n,
      shareAmountLD: 999_000n,
      minShareAmountLD: 998_000n,
      refundAddress: TEST_WALLET.address,
      extraOptions: KATANA_FORWARD_CONFIG.extraOptions,
      composeMsg: KATANA_FORWARD_CONFIG.composeMsg,
      oftCmd: KATANA_FORWARD_CONFIG.oftCmd,
    });
    const route: KatanaBridgeRoute = {
      kind: 'ethereum-to-katana',
      fromChainId: ETHEREUM_CHAIN_ID,
      toChainId: KATANA_CHAIN_ID,
      fromToken: KATANA_FORWARD_CONFIG.fromToken,
      toToken: KATANA_FORWARD_CONFIG.toToken,
      recipient: TEST_WALLET.address,
      refundAddress: TEST_WALLET.address,
      previewAmount: 999_000n,
      nativeFee: 123n,
      sendParam: exactCall.sendParam,
      quoteRead: exactCall.quoteRead,
      approvalCall: exactCall.assetApproveTx,
      executionCall: { ...exactCall.depositAndSendTx, value: 123n },
    };
    const quote = createForwardQuote(route);

    bridge.allowance = route.approvalCall.amount;
    bridge.nextReceipts = [createReceipt('0xexecute', [])];

    await bridge.execute(quote, {
      [ProtocolType.Ethereum]: TEST_PRIVATE_KEY,
    });

    expect(bridge.sentCalls).to.have.length(1);
    expect(bridge.sentCalls[0].call.data).to.equal(route.executionCall.data);
  });
});

describe('KatanaBridge.getStatus()', () => {
  it('parses forward destination OFTReceived amount', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.nextFetchResponse = new Response(
      JSON.stringify({
        messages: [{ status: 'DELIVERED', dstTxHash: '0xdstforward' }],
      }),
      { status: 200 },
    );
    bridge.setReceipt(
      KATANA_CHAIN_ID,
      '0xdstforward',
      createReceipt('0xdstforward', [
        createEventLog(
          KATANA_FORWARD_CONFIG.destinationShareOftAddress,
          oftInterface,
          'OFTReceived',
          [
            '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            KATANA_FORWARD_CONFIG.dstEid,
            TEST_WALLET.address,
            777_000n,
          ],
        ),
      ]),
    );

    const status = await bridge.getStatus(
      '0xsource',
      ETHEREUM_CHAIN_ID,
      KATANA_CHAIN_ID,
    );

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdstforward',
      receivedAmount: 777_000n,
    });
  });

  it('parses reverse destination Redeemed amount', async () => {
    const bridge = new TestKatanaBridge(BRIDGE_CONFIG, testLogger);
    bridge.nextFetchResponse = new Response(
      JSON.stringify({
        messages: [{ status: 'DELIVERED', dstTxHash: '0xdstreverse' }],
      }),
      { status: 200 },
    );
    bridge.setReceipt(
      ETHEREUM_CHAIN_ID,
      '0xdstreverse',
      createReceipt('0xdstreverse', [
        createEventLog(
          KATANA_REVERSE_CONFIG.composerAddress,
          composerInterface,
          'Redeemed',
          [
            '0x0000000000000000000000000000000000000000000000000000000000000000',
            '0x0000000000000000000000000000000000000000000000000000000000000000',
            KATANA_REVERSE_CONFIG.dstEid,
            500_000n,
            499_000n,
          ],
        ),
      ]),
    );

    const status = await bridge.getStatus(
      '0xsource',
      KATANA_CHAIN_ID,
      ETHEREUM_CHAIN_ID,
    );

    expect(status).to.deep.equal({
      status: 'complete',
      receivingTxHash: '0xdstreverse',
      receivedAmount: 499_000n,
    });
  });
});
