import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { TronWallet } from '@hyperlane-xyz/tron-sdk/runtime';
import { ProtocolType, addressToBytesTron, assert } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import { waitForReceiptWithTimeout } from '../utils/receiptTimeout.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';
import { approveErc20IfNeeded } from './erc20Approve.js';
import {
  DEBRIDGE_API_BASE,
  DEBRIDGE_STATUS_API,
  DEBRIDGE_TOOL,
  DEBRIDGE_TRON_CHAIN_ID,
  type DeBridgeCreateTxResponse,
  type DeBridgeQuoteResponse,
  type DeBridgeTokenEstimation,
  formatAddressForDebridge,
  hyperlaneChainIdToDebridge,
  isDebridgeSolanaChain,
  isDebridgeTronChain,
  parseDeBridgeCreateTxResponse,
  parseDeBridgeOrderStatusResponse,
  parseDeBridgeQuoteResponse,
} from './deBridgeUtils.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_FEE_PERCENT = 10;
const MAX_PERCENT = 100;
const BASIS_POINTS_PER_PERCENT = 100;
const BASIS_POINTS_DENOMINATOR = 10_000n;

export interface DeBridgeBridgeConfig {
  apiUrl?: string;
  statusApiUrl?: string;
  chainMetadata?: ChainMap<ChainMetadata>;
  maxFeePercent?: number;
}

export class DeBridgeBridge implements IExternalBridge {
  readonly externalBridgeId = DEBRIDGE_TOOL;
  readonly logger: Logger;

  private readonly apiUrl: string;
  private readonly statusApiUrl: string;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;
  private readonly maxFeeBps: number;

  constructor(config: DeBridgeBridgeConfig, logger: Logger) {
    this.logger = logger;
    this.apiUrl = this.validateApiUrl(config.apiUrl ?? DEBRIDGE_API_BASE);
    this.statusApiUrl = this.validateApiUrl(
      config.statusApiUrl ?? DEBRIDGE_STATUS_API,
    );

    const maxFeePercent = config.maxFeePercent ?? DEFAULT_MAX_FEE_PERCENT;
    assert(
      Number.isFinite(maxFeePercent) &&
        maxFeePercent >= 0 &&
        maxFeePercent <= MAX_PERCENT,
      `maxFeePercent must be between 0 and ${MAX_PERCENT}`,
    );
    const maxFeeBps = maxFeePercent * BASIS_POINTS_PER_PERCENT;
    assert(
      Number.isInteger(maxFeeBps),
      'maxFeePercent must have at most two decimal places',
    );
    this.maxFeeBps = maxFeeBps;

    this.chainMetadataByChainId = new Map();
    for (const metadata of Object.values(config.chainMetadata ?? {})) {
      if (
        metadata.chainId === undefined ||
        (metadata.protocol !== ProtocolType.Ethereum &&
          metadata.protocol !== ProtocolType.Tron &&
          metadata.protocol !== ProtocolType.Sealevel)
      ) {
        continue;
      }

      const chainId = Number(metadata.chainId);
      assert(
        !this.chainMetadataByChainId.has(chainId),
        `Duplicate chain metadata for chain ID ${chainId}`,
      );
      this.chainMetadataByChainId.set(chainId, metadata);
    }
  }

  async quote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    this.validateQuoteParams(params);

    const srcDebridgeChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstDebridgeChainId = hyperlaneChainIdToDebridge(params.toChain);
    const srcToken = formatAddressForDebridge(
      params.fromToken,
      srcDebridgeChainId,
    );
    const dstToken = formatAddressForDebridge(
      params.toToken,
      dstDebridgeChainId,
    );
    formatAddressForDebridge(params.fromAddress, srcDebridgeChainId);
    if (params.toAddress) {
      formatAddressForDebridge(params.toAddress, dstDebridgeChainId);
    }

    const url = this.buildApiUrl('/dln/order/quote', {
      srcChainId: srcDebridgeChainId.toString(),
      srcChainTokenIn: srcToken,
      srcChainTokenInAmount: params.fromAmount?.toString() ?? 'auto',
      dstChainId: dstDebridgeChainId.toString(),
      dstChainTokenOut: dstToken,
      dstChainTokenOutAmount: params.toAmount?.toString() ?? 'auto',
      prependOperatingExpenses: 'false',
    });

    this.logger.debug(
      {
        fromChain: params.fromChain,
        toChain: params.toChain,
        srcDebridgeChainId,
        dstDebridgeChainId,
      },
      'Requesting deBridge quote',
    );

    const response = await this.fetchWithRetry(url);
    const body: unknown = await response.json();
    const data = parseDeBridgeQuoteResponse(body);
    this.validateEstimation(data, params);
    this.assertFeeWithinLimit(data, params.fromChain, params.toChain);

    const fromAmount = BigInt(data.estimation.srcChainTokenIn.amount);
    const toAmount = BigInt(data.estimation.dstChainTokenOut.amount);
    const feeCosts =
      BigInt(data.fixFee ?? '0') + BigInt(data.protocolFee ?? '0');

    return {
      id: uuidv4(),
      tool: DEBRIDGE_TOOL,
      fromAmount,
      toAmount,
      toAmountMin: toAmount,
      executionDuration: 60,
      gasCosts: 0n,
      feeCosts,
      route: data,
      requestParams: { ...params },
    };
  }

  async execute(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    assert(quote.tool === DEBRIDGE_TOOL, 'Quote was not created by deBridge');
    assert(quote.fromAmount > 0n, 'Quote fromAmount must be positive');
    assert(quote.toAmountMin > 0n, 'Quote toAmountMin must be positive');
    const quotedRoute = parseDeBridgeQuoteResponse(quote.route);
    const params = quote.requestParams;
    this.validateQuoteParams(params);
    this.validateEstimation(quotedRoute, params);
    assert(
      BigInt(quotedRoute.estimation.srcChainTokenIn.amount) ===
        quote.fromAmount,
      'Quote route fromAmount does not match quote',
    );
    assert(
      BigInt(quotedRoute.estimation.dstChainTokenOut.amount) === quote.toAmount,
      'Quote route toAmount does not match quote',
    );

    const srcDebridgeChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstDebridgeChainId = hyperlaneChainIdToDebridge(params.toChain);
    const sourceProtocol = this.getProtocol(srcDebridgeChainId);
    const sourcePrivateKey = privateKeys[sourceProtocol];
    assert(sourcePrivateKey, `Missing private key for ${sourceProtocol} chain`);
    assert(params.toAddress, 'toAddress is required for deBridge execution');

    const senderAddress = this.deriveAndValidateSender(
      sourceProtocol,
      sourcePrivateKey,
      params.fromAddress,
      srcDebridgeChainId,
    );
    const recipientAddress = formatAddressForDebridge(
      params.toAddress,
      dstDebridgeChainId,
    );
    const srcToken = formatAddressForDebridge(
      params.fromToken,
      srcDebridgeChainId,
    );
    const dstToken = formatAddressForDebridge(
      params.toToken,
      dstDebridgeChainId,
    );

    const createTxUrl = this.buildApiUrl('/dln/order/create-tx', {
      srcChainId: srcDebridgeChainId.toString(),
      srcChainTokenIn: srcToken,
      srcChainTokenInAmount: quote.fromAmount.toString(),
      dstChainId: dstDebridgeChainId.toString(),
      dstChainTokenOut: dstToken,
      dstChainTokenOutAmount: 'auto',
      dstChainTokenOutRecipient: recipientAddress,
      senderAddress,
      srcChainOrderAuthorityAddress: senderAddress,
      srcChainRefundAddress: senderAddress,
      dstChainOrderAuthorityAddress: recipientAddress,
      prependOperatingExpenses: 'false',
    });

    this.logger.info(
      {
        fromChain: params.fromChain,
        toChain: params.toChain,
        amount: quote.fromAmount.toString(),
        sender: senderAddress,
        recipient: recipientAddress,
      },
      'Creating deBridge order transaction',
    );

    const response = await this.fetchWithRetry(createTxUrl);
    const body: unknown = await response.json();
    const createTx = parseDeBridgeCreateTxResponse(body);
    this.validateEstimation(createTx, params, {
      exactFromAmount: quote.fromAmount,
      minimumToAmount: quote.toAmountMin,
    });
    this.assertFeeWithinLimit(createTx, params.fromChain, params.toChain);

    switch (sourceProtocol) {
      case ProtocolType.Ethereum:
      case ProtocolType.Tron:
        return this.executeEvmLike(
          sourceProtocol,
          sourcePrivateKey,
          createTx,
          quote,
        );
      case ProtocolType.Sealevel:
        return this.executeSolana(sourcePrivateKey, createTx, quote);
      default: {
        const exhaustiveProtocol: never = sourceProtocol;
        throw new Error(`Unsupported source protocol: ${exhaustiveProtocol}`);
      }
    }
  }

  async getStatus(
    txHash: string,
    _fromChain: number,
    _toChain: number,
    transferId?: string,
  ): Promise<BridgeTransferStatus> {
    assert(
      transferId && /^0x[0-9a-fA-F]{64}$/.test(transferId),
      'A valid deBridge order ID is required to check transfer status',
    );
    const url = new URL(
      `/v1.0/dln/order/${encodeURIComponent(transferId)}/status`,
      this.statusApiUrl,
    ).toString();

    this.logger.debug(
      { txHash, orderId: transferId },
      'Checking deBridge order',
    );
    const response = await this.fetchWithRetry(url);
    const body: unknown = await response.json();
    const data = parseDeBridgeOrderStatusResponse(body);
    assert(
      data.orderId.toLowerCase() === transferId.toLowerCase(),
      `deBridge status returned unexpected order ID ${data.orderId}`,
    );

    switch (data.status) {
      case 'None':
        return { status: 'not_found' };
      case 'Created':
        return { status: 'pending', substatus: data.status };
      case 'Fulfilled':
      case 'SentUnlock':
      case 'ClaimedUnlock':
        return {
          status: 'complete',
          receivingTxHash:
            data.fulfilledDstEventMetadata?.transactionHash?.stringValue ?? '',
          receivedAmount: BigInt(
            data.fulfilledDstEventMetadata?.receivedAmount?.bigIntegerValue ??
              '0',
          ),
        };
      case 'OrderCancelled':
      case 'SentOrderCancel':
      case 'ClaimedOrderCancel':
        return { status: 'failed', error: data.status };
      default: {
        const exhaustiveStatus: never = data.status;
        throw new Error(`Unsupported deBridge status: ${exhaustiveStatus}`);
      }
    }
  }

  private async executeEvmLike(
    protocol: ProtocolType.Ethereum | ProtocolType.Tron,
    privateKey: string,
    createTx: DeBridgeCreateTxResponse,
    quote: BridgeQuote,
  ): Promise<BridgeTransferResult> {
    const { tx, fixFee, orderId } = createTx;
    assert(tx.to, 'deBridge create-tx response is missing tx.to');
    assert(tx.value, 'deBridge create-tx response is missing tx.value');
    assert(
      ethers.utils.isAddress(tx.to),
      `deBridge returned invalid transaction target: ${tx.to}`,
    );

    const rpcUrl = this.getRpcUrl(quote.requestParams.fromChain);
    const wallet =
      protocol === ProtocolType.Tron
        ? new TronWallet(privateKey, rpcUrl)
        : new ethers.Wallet(
            privateKey,
            new ethers.providers.StaticJsonRpcProvider(
              rpcUrl,
              quote.requestParams.fromChain,
            ),
          );
    const tokenAddress = this.getEvmLikeAddress(
      quote.requestParams.fromToken,
      protocol,
    );
    const isNativeToken =
      tokenAddress === ethers.constants.AddressZero.toLowerCase();
    const expectedValue =
      BigInt(fixFee) + (isNativeToken ? quote.fromAmount : 0n);
    assert(
      BigInt(tx.value) === expectedValue,
      `deBridge transaction value ${tx.value} does not match expected ${expectedValue}`,
    );

    if (!isNativeToken) {
      assert(
        tokenAddress !== tx.to.toLowerCase(),
        'deBridge transaction target cannot be the source token contract',
      );
      await approveErc20IfNeeded(
        wallet,
        tokenAddress,
        tx.to,
        quote.fromAmount,
        this.logger,
      );
    }

    this.logger.info(
      {
        from: wallet.address,
        to: tx.to,
        fromChain: quote.requestParams.fromChain,
        orderId,
      },
      `Sending deBridge ${protocol} transaction`,
    );
    const transaction = await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: ethers.BigNumber.from(tx.value),
    });
    const receipt = await waitForReceiptWithTimeout(transaction.wait(), {
      txHash: transaction.hash,
      operation: 'deBridge origin transaction',
    });
    assert(
      receipt.status === 1,
      `deBridge origin transaction failed: ${transaction.hash}`,
    );

    return {
      txHash: transaction.hash,
      fromChain: quote.requestParams.fromChain,
      toChain: quote.requestParams.toChain,
      transferId: orderId,
    };
  }

  private async executeSolana(
    privateKey: string,
    createTx: DeBridgeCreateTxResponse,
    quote: BridgeQuote,
  ): Promise<BridgeTransferResult> {
    const keypair = Keypair.fromSecretKey(parseSolanaPrivateKey(privateKey));
    const serialized = Buffer.from(createTx.tx.data.slice(2), 'hex');
    const transaction = VersionedTransaction.deserialize(serialized);
    assert(
      transaction.message.header.numRequiredSignatures === 1,
      'deBridge Solana transaction must require exactly one signer',
    );
    assert(
      transaction.message.staticAccountKeys[0]?.equals(keypair.publicKey),
      'deBridge Solana transaction signer does not match inventory signer',
    );

    const connection = new Connection(
      this.getRpcUrl(quote.requestParams.fromChain),
    );
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.message.recentBlockhash = blockhash;
    transaction.sign([keypair]);

    const signature = await connection.sendTransaction(transaction);
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    assert(
      confirmation.value.err === null,
      `deBridge Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`,
    );

    return {
      txHash: signature,
      fromChain: quote.requestParams.fromChain,
      toChain: quote.requestParams.toChain,
      transferId: createTx.orderId,
    };
  }

  private deriveAndValidateSender(
    protocol: ProtocolType.Ethereum | ProtocolType.Tron | ProtocolType.Sealevel,
    privateKey: string,
    configuredAddress: string,
    srcDebridgeChainId: number,
  ): string {
    let derivedAddress: string;
    switch (protocol) {
      case ProtocolType.Ethereum:
      case ProtocolType.Tron:
        derivedAddress = new ethers.Wallet(privateKey).address;
        break;
      case ProtocolType.Sealevel:
        derivedAddress = Keypair.fromSecretKey(
          parseSolanaPrivateKey(privateKey),
        ).publicKey.toBase58();
        break;
      default: {
        const exhaustiveProtocol: never = protocol;
        throw new Error(`Unsupported source protocol: ${exhaustiveProtocol}`);
      }
    }

    const formattedDerived = formatAddressForDebridge(
      derivedAddress,
      srcDebridgeChainId,
    );
    const formattedConfigured = formatAddressForDebridge(
      configuredAddress,
      srcDebridgeChainId,
    );
    const matches =
      protocol === ProtocolType.Ethereum
        ? formattedDerived.toLowerCase() === formattedConfigured.toLowerCase()
        : formattedDerived === formattedConfigured;
    assert(matches, `${protocol} private key does not match inventory signer`);
    return formattedDerived;
  }

  private validateQuoteParams(params: BridgeQuoteParams): void {
    assert(
      params.fromChain !== params.toChain,
      'Source and destination must differ',
    );
    assert(
      !(params.fromAmount !== undefined && params.toAmount !== undefined),
      'Cannot specify both fromAmount and toAmount',
    );
    assert(
      params.fromAmount !== undefined || params.toAmount !== undefined,
      'Must specify either fromAmount or toAmount',
    );
    if (params.fromAmount !== undefined) {
      assert(params.fromAmount > 0n, 'fromAmount must be positive');
    }
    if (params.toAmount !== undefined) {
      assert(params.toAmount > 0n, 'toAmount must be positive');
    }
  }

  private validateEstimation(
    response: DeBridgeQuoteResponse,
    params: BridgeQuoteParams,
    limits?: { exactFromAmount: bigint; minimumToAmount: bigint },
  ): void {
    const srcChainId = hyperlaneChainIdToDebridge(params.fromChain);
    const dstChainId = hyperlaneChainIdToDebridge(params.toChain);
    const { srcChainTokenIn, dstChainTokenOut } = response.estimation;

    assert(
      srcChainTokenIn.chainId === srcChainId,
      `deBridge returned unexpected source chain ${srcChainTokenIn.chainId}`,
    );
    assert(
      dstChainTokenOut.chainId === dstChainId,
      `deBridge returned unexpected destination chain ${dstChainTokenOut.chainId}`,
    );
    assert(
      this.addressesEqual(
        srcChainTokenIn.address,
        params.fromToken,
        srcChainId,
      ),
      `deBridge returned unexpected source token ${srcChainTokenIn.address}`,
    );
    assert(
      this.addressesEqual(dstChainTokenOut.address, params.toToken, dstChainId),
      `deBridge returned unexpected destination token ${dstChainTokenOut.address}`,
    );

    const fromAmount = BigInt(srcChainTokenIn.amount);
    const toAmount = BigInt(dstChainTokenOut.amount);
    assert(fromAmount > 0n, 'deBridge source amount must be positive');
    assert(toAmount > 0n, 'deBridge destination amount must be positive');
    const exactFromAmount = limits?.exactFromAmount ?? params.fromAmount;
    if (exactFromAmount !== undefined) {
      assert(
        fromAmount === exactFromAmount,
        `deBridge returned unexpected source amount ${fromAmount}`,
      );
    }
    const minimumToAmount = limits?.minimumToAmount ?? params.toAmount;
    if (minimumToAmount !== undefined) {
      assert(
        toAmount >= minimumToAmount,
        `deBridge destination amount ${toAmount} is below required ${minimumToAmount}`,
      );
    }
  }

  private assertFeeWithinLimit(
    response: DeBridgeQuoteResponse,
    fromChain: number,
    toChain: number,
  ): void {
    const { srcChainTokenIn, dstChainTokenOut } = response.estimation;
    const commonDecimals = Math.max(
      srcChainTokenIn.decimals,
      dstChainTokenOut.decimals,
    );
    const sourceAmount = this.scaleAmount(srcChainTokenIn, commonDecimals);
    const destinationAmount = this.scaleAmount(
      dstChainTokenOut,
      commonDecimals,
    );
    const feeAmount =
      sourceAmount > destinationAmount ? sourceAmount - destinationAmount : 0n;
    const feeBps =
      feeAmount === 0n
        ? 0n
        : (feeAmount * BASIS_POINTS_DENOMINATOR + sourceAmount - 1n) /
          sourceAmount;

    this.logger.info(
      {
        fromChain,
        toChain,
        feeBps: feeBps.toString(),
        maxFeeBps: this.maxFeeBps,
      },
      'deBridge fee guard',
    );
    assert(
      feeBps <= BigInt(this.maxFeeBps),
      `deBridge fee too high: ${feeBps} bps. Max allowed: ${this.maxFeeBps} bps`,
    );
  }

  private scaleAmount(
    estimation: DeBridgeTokenEstimation,
    decimals: number,
  ): bigint {
    return (
      BigInt(estimation.amount) * 10n ** BigInt(decimals - estimation.decimals)
    );
  }

  private addressesEqual(
    first: string,
    second: string,
    debridgeChainId: number,
  ): boolean {
    const formattedFirst = formatAddressForDebridge(first, debridgeChainId);
    const formattedSecond = formatAddressForDebridge(second, debridgeChainId);
    return isDebridgeSolanaChain(debridgeChainId) ||
      isDebridgeTronChain(debridgeChainId)
      ? formattedFirst === formattedSecond
      : formattedFirst.toLowerCase() === formattedSecond.toLowerCase();
  }

  private getEvmLikeAddress(
    address: string,
    protocol: ProtocolType.Ethereum | ProtocolType.Tron,
  ): string {
    if (protocol === ProtocolType.Ethereum) {
      assert(
        ethers.utils.isAddress(address),
        `Invalid EVM address: ${address}`,
      );
      return address.toLowerCase();
    }

    const formatted = formatAddressForDebridge(address, DEBRIDGE_TRON_CHAIN_ID);
    return ethers.utils.hexlify(addressToBytesTron(formatted)).toLowerCase();
  }

  private getProtocol(
    debridgeChainId: number,
  ): ProtocolType.Ethereum | ProtocolType.Tron | ProtocolType.Sealevel {
    if (isDebridgeTronChain(debridgeChainId)) return ProtocolType.Tron;
    if (isDebridgeSolanaChain(debridgeChainId)) return ProtocolType.Sealevel;
    return ProtocolType.Ethereum;
  }

  private getRpcUrl(chainId: number): string {
    const rpcUrl = this.chainMetadataByChainId.get(chainId)?.rpcUrls?.[0]?.http;
    assert(rpcUrl, `No RPC URL configured for chain ${chainId}`);
    return rpcUrl;
  }

  private validateApiUrl(rawUrl: string): string {
    const url = new URL(rawUrl);
    assert(url.protocol === 'https:', 'deBridge API URL must use HTTPS');
    return url.toString();
  }

  private buildApiUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`/v1.0${path}`, this.apiUrl);
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (attempt - 1)),
        );
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          const body = await response.text();
          throw new Error(`deBridge HTTP ${response.status}: ${body}`);
        }
        if (response.ok) return response;
        lastError = new Error(`deBridge HTTP ${response.status}`);
      } catch (error) {
        if (
          error instanceof Error &&
          /^deBridge HTTP 4\d\d:/.test(error.message)
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error('deBridge request exhausted retries');
  }
}
