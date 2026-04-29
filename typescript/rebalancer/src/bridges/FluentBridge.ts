import { ethers } from 'ethers';
import type { Logger } from 'pino';

import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  ensure0x,
  normalizeAddressEvm,
} from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  ExternalBridgeConfig,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import {
  ETHEREUM_CHAIN_ID,
  FLUENT_CHAIN_ID,
  FLUENT_FORWARD_CONFIG,
  FLUENT_REVERSE_CONFIG,
  type FluentDirection,
  type FluentExecutionTx,
  MessageStatus,
  NATIVE_TOKEN_SENTINEL,
  buildEthereumToFluentDeposit,
  buildFluentToEthereumWithdraw,
  extractMessageHashFromReceipt,
  extractSentMessageFromReceipt,
  fluentBridgeInterface,
} from './fluentUtils.js';

// Empirically observed timings (mainnet round-trip 2026-04-29):
// deposit ~2 min, withdrawal ~6 min. Plus margin.
const DEPOSIT_EXECUTION_DURATION_S = 5 * 60;
const WITHDRAW_EXECUTION_DURATION_S = 15 * 60;

export type FluentBridgeRoute = {
  id: string;
  kind: FluentDirection;
  fromChainId: number;
  toChainId: number;
  fromToken: string;
  toToken: string;
  recipient: string;
  executionTx: FluentExecutionTx;
  messageFee: bigint;
};

type FluentExecutionState = {
  kind: FluentDirection;
  recipient: string;
  expectedReceivedAmount: bigint;
  messageHash?: string;
};

function addressesEqual(a: string, b: string): boolean {
  return normalizeAddressEvm(a) === normalizeAddressEvm(b);
}

function normalizeTxHash(txHash: string): string {
  return txHash.startsWith('0x')
    ? txHash.toLowerCase()
    : `0x${txHash.toLowerCase()}`;
}

export class FluentBridge implements IExternalBridge {
  readonly externalBridgeId = 'fluent';
  readonly logger: Logger;

  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;
  private readonly executionStateByTxHash = new Map<
    string,
    FluentExecutionState
  >();

  constructor(config: ExternalBridgeConfig, logger: Logger) {
    this.logger = logger;
    this.chainMetadataByChainId = new Map();
    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
        if (
          metadata.chainId !== undefined &&
          metadata.protocol === ProtocolType.Ethereum
        ) {
          this.chainMetadataByChainId.set(Number(metadata.chainId), metadata);
        }
      }
    }
  }

  getNativeTokenAddress(): string {
    return NATIVE_TOKEN_SENTINEL;
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<FluentBridgeRoute>> {
    const { fromChain, toChain, fromAmount, toAmount, fromToken, toToken } =
      params;
    const direction = this.getDirection(fromChain, toChain, fromToken, toToken);
    assert(direction, `Unsupported Fluent route: ${fromChain} -> ${toChain}`);
    assert(toAmount === undefined, 'FluentBridge only supports fromAmount');
    assert(fromAmount !== undefined, 'FluentBridge requires fromAmount');
    assert(fromAmount > 0n, 'FluentBridge requires a positive fromAmount');

    const recipient = normalizeAddressEvm(
      params.toAddress ?? params.fromAddress,
    );
    const messageFee = await this.readMessageFee(fromChain);

    const config =
      direction === 'ethereum-to-fluent'
        ? FLUENT_FORWARD_CONFIG
        : FLUENT_REVERSE_CONFIG;

    const executionTx =
      direction === 'ethereum-to-fluent'
        ? buildEthereumToFluentDeposit({
            nativeGateway: config.nativeGatewayAddress,
            recipient,
            amount: fromAmount,
            messageFee,
          })
        : buildFluentToEthereumWithdraw({
            nativeGateway: config.nativeGatewayAddress,
            recipient,
            amount: fromAmount,
            messageFee,
          });

    return {
      id: crypto.randomUUID(),
      tool: 'fluent',
      fromAmount,
      // 1:1 native pass-through. No DEX hop and no liquidity, so no slippage.
      toAmount: fromAmount,
      toAmountMin: fromAmount,
      executionDuration:
        direction === 'ethereum-to-fluent'
          ? DEPOSIT_EXECUTION_DURATION_S
          : WITHDRAW_EXECUTION_DURATION_S,
      gasCosts: messageFee,
      feeCosts: 0n,
      route: {
        id: crypto.randomUUID(),
        kind: direction,
        fromChainId: fromChain,
        toChainId: toChain,
        fromToken: normalizeAddressEvm(fromToken),
        toToken: normalizeAddressEvm(toToken),
        recipient,
        executionTx,
        messageFee,
      },
      requestParams: params,
    };
  }

  async execute(
    quote: BridgeQuote<FluentBridgeRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const route = quote.route;
    assert(route, 'FluentBridge requires a populated route');

    const key = privateKeys[ProtocolType.Ethereum];
    assert(key, 'Missing EVM private key for FluentBridge execution');

    const signerAddress = normalizeAddressEvm(
      new ethers.Wallet(ensure0x(key)).address,
    );
    this.validateExecutionQuote(quote, route, signerAddress);

    const sourceReceipt = await this.sendPreparedTransaction(
      route.executionTx.chainId,
      key,
      route.executionTx,
    );
    const sourceTxHash = normalizeTxHash(sourceReceipt.transactionHash);
    const messageHash = extractMessageHashFromReceipt(sourceReceipt);
    assert(
      messageHash,
      `FluentBridge source tx ${sourceTxHash} did not emit a SentMessage event`,
    );

    this.executionStateByTxHash.set(sourceTxHash, {
      kind: route.kind,
      recipient: route.recipient,
      expectedReceivedAmount: quote.toAmountMin,
      messageHash,
    });

    return {
      txHash: sourceTxHash,
      fromChain: route.fromChainId,
      toChain: route.toChainId,
      transferId: messageHash,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    const normalizedTxHash = normalizeTxHash(txHash);
    let state = this.executionStateByTxHash.get(normalizedTxHash);
    if (!state) {
      const rehydrated = await this.rehydrateExecutionState(
        normalizedTxHash,
        fromChain,
        toChain,
      );
      if (rehydrated) {
        this.executionStateByTxHash.set(normalizedTxHash, rehydrated);
        state = rehydrated;
      }
    }
    if (!state) return { status: 'not_found' };

    if (!state.messageHash) {
      const sourceReceipt = await this.getTransactionReceipt(
        fromChain,
        normalizedTxHash,
      );
      if (!sourceReceipt) {
        return { status: 'pending', substatus: 'SOURCE_PENDING' };
      }
      const messageHash = extractMessageHashFromReceipt(sourceReceipt);
      if (!messageHash) {
        return { status: 'pending', substatus: 'MESSAGE_HASH_PENDING' };
      }
      state.messageHash = messageHash;
    }

    const status = await this.readMessageStatus(toChain, state.messageHash);

    if (status === MessageStatus.None) {
      return { status: 'pending', substatus: 'IN_FLIGHT' };
    }
    if (status === MessageStatus.Failed) {
      return {
        status: 'failed',
        error: 'destination call reverted',
      };
    }

    // MessageStatus.Success: native ETH transit is 1:1, so receivedAmount
    // is known statically from the source tx. We deliberately do NOT search
    // L1 logs for the delivery tx — `getReceivedMessage(messageHash) = 2` is
    // sufficient proof of completion.
    return {
      status: 'complete',
      receivedAmount: state.expectedReceivedAmount,
    };
  }

  protected getProvider(
    chainId: number,
  ): ethers.providers.StaticJsonRpcProvider {
    return new ethers.providers.StaticJsonRpcProvider(
      this.getRpcUrl(chainId),
      chainId,
    );
  }

  protected async readContract(
    chainId: number,
    to: string,
    data: string,
  ): Promise<string> {
    return this.getProvider(chainId).call({ to, data });
  }

  protected async getCurrentBlockNumber(chainId: number): Promise<number> {
    return this.getProvider(chainId).getBlockNumber();
  }

  protected async getTransactionReceipt(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionReceipt | null> {
    return this.getProvider(chainId).getTransactionReceipt(txHash);
  }

  protected async getTransaction(
    chainId: number,
    txHash: string,
  ): Promise<ethers.providers.TransactionResponse | null> {
    return this.getProvider(chainId).getTransaction(txHash);
  }

  protected async sendPreparedTransaction(
    chainId: number,
    privateKey: string,
    tx: FluentExecutionTx,
  ): Promise<ethers.providers.TransactionReceipt> {
    const wallet = new ethers.Wallet(
      ensure0x(privateKey),
      this.getProvider(chainId),
    );
    const response = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: ethers.BigNumber.from(tx.value),
    });
    return response.wait();
  }

  protected async readMessageFee(chainId: number): Promise<bigint> {
    const data = fluentBridgeInterface.encodeFunctionData(
      'getSentMessageFee',
      [],
    );
    const result = await this.readContract(
      chainId,
      this.getFluentBridgeAddress(chainId),
      data,
    );
    const decoded = fluentBridgeInterface.decodeFunctionResult(
      'getSentMessageFee',
      result,
    );
    return BigInt(decoded[0].toString());
  }

  protected async readMessageStatus(
    chainId: number,
    messageHash: string,
  ): Promise<number> {
    const data = fluentBridgeInterface.encodeFunctionData(
      'getReceivedMessage',
      [messageHash],
    );
    const result = await this.readContract(
      chainId,
      this.getFluentBridgeAddress(chainId),
      data,
    );
    const decoded = fluentBridgeInterface.decodeFunctionResult(
      'getReceivedMessage',
      result,
    );
    return Number(decoded[0]);
  }

  private async rehydrateExecutionState(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<FluentExecutionState | undefined> {
    const direction = this.getDirectionFromChains(fromChain, toChain);
    if (!direction) return undefined;

    const transaction = await this.getTransaction(fromChain, txHash);
    if (!transaction?.from) return undefined;

    const sourceReceipt = await this.getTransactionReceipt(fromChain, txHash);
    const sentMessage = sourceReceipt
      ? extractSentMessageFromReceipt(sourceReceipt)
      : undefined;

    // Without the original transferRecipient we fall back to the source signer.
    // For rebalancer flows the signer is the recipient on the destination
    // anyway (HypNative recipient = inventory signer address).
    const recipient = normalizeAddressEvm(transaction.from);

    return {
      kind: direction,
      recipient,
      // Recover the cross-chain ETH amount from the SentMessage event
      // (gross value minus the bridge fee).
      expectedReceivedAmount: sentMessage?.bridgedAmount ?? 0n,
      messageHash: sentMessage?.messageHash,
    };
  }

  private getDirection(
    fromChain: number,
    toChain: number,
    fromToken: string,
    toToken: string,
  ): FluentDirection | undefined {
    const direction = this.getDirectionFromChains(fromChain, toChain);
    if (!direction) return undefined;
    const config =
      direction === 'ethereum-to-fluent'
        ? FLUENT_FORWARD_CONFIG
        : FLUENT_REVERSE_CONFIG;
    if (
      addressesEqual(fromToken, config.fromToken) &&
      addressesEqual(toToken, config.toToken)
    ) {
      return direction;
    }
    return undefined;
  }

  private getDirectionFromChains(
    fromChain: number,
    toChain: number,
  ): FluentDirection | undefined {
    if (fromChain === ETHEREUM_CHAIN_ID && toChain === FLUENT_CHAIN_ID) {
      return 'ethereum-to-fluent';
    }
    if (fromChain === FLUENT_CHAIN_ID && toChain === ETHEREUM_CHAIN_ID) {
      return 'fluent-to-ethereum';
    }
    return undefined;
  }

  private getFluentBridgeAddress(_chainId: number): string {
    return FLUENT_FORWARD_CONFIG.fluentBridgeAddress;
  }

  private validateExecutionQuote(
    quote: BridgeQuote<FluentBridgeRoute>,
    route: FluentBridgeRoute,
    signerAddress: string,
  ): void {
    const expectedDirection = this.getDirection(
      quote.requestParams.fromChain,
      quote.requestParams.toChain,
      quote.requestParams.fromToken,
      quote.requestParams.toToken,
    );
    assert(
      expectedDirection === route.kind,
      'Route kind does not match request',
    );
    assert(
      quote.requestParams.fromAmount === quote.fromAmount,
      'Quote fromAmount does not match request',
    );
    assert(
      addressesEqual(quote.requestParams.fromAddress, signerAddress),
      `Signer ${signerAddress} does not match quote.fromAddress ${quote.requestParams.fromAddress}`,
    );

    const expectedRecipient = normalizeAddressEvm(
      quote.requestParams.toAddress ?? quote.requestParams.fromAddress,
    );
    assert(
      addressesEqual(route.recipient, expectedRecipient),
      `Route recipient ${route.recipient} does not match quote recipient ${expectedRecipient}`,
    );
    assert(
      route.executionTx.chainId === route.fromChainId,
      `Fluent execution chain ${route.executionTx.chainId} did not match source chain ${route.fromChainId}`,
    );
  }

  private getRpcUrl(chainId: number): string {
    const metadata = this.chainMetadataByChainId.get(chainId);
    assert(
      metadata,
      `Missing chain metadata for Fluent bridge chainId ${chainId}`,
    );
    const rpcUrl = metadata.rpcUrls?.[0]?.http;
    assert(rpcUrl, `Missing RPC URL for Fluent bridge chainId ${chainId}`);
    return rpcUrl;
  }
}
