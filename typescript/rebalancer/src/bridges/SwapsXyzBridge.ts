import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  ensure0x,
  isEVMLike,
  retryAsync,
} from '@hyperlane-xyz/utils';
import { BigNumber, Contract, Wallet, providers } from 'ethers';
import type { Logger } from 'pino';

import { ExternalBridgeType } from '../config/types.js';
import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';

import {
  approveErc20IfNeeded,
  type Erc20ContractFactory,
} from './erc20Approve.js';
import {
  SwapsXyzClient,
  SwapsXyzRequestError,
  isEvmTx,
  isSwapsXyzNotFoundError,
  type SwapsXyzActionRequest,
  type SwapsXyzActionResponse,
  type SwapsXyzStatusResponse,
} from './SwapsXyzClient.js';

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_SLIPPAGE = 0.005;
const REVERSE_QUOTE_ATTEMPTS = 4;
const REVERSE_QUOTE_HEADROOM_BPS = 30n;
const BPS_DENOMINATOR = 10_000n;
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const REGISTER_TX_RETRY_DELAY_MS = 2_000;
const UNSAFE_SOURCE_TOKEN_SELECTORS = new Set([
  '095ea7b3', // approve(address,uint256)
  '23b872dd', // transferFrom(address,address,uint256)
  'a9059cbb', // transfer(address,uint256)
]);

export interface SwapsXyzBridgeConfig {
  apiKey: string;
  apiUrl?: string;
  defaultSlippage?: number;
  maxQuoteLossBps?: number;
  chainMetadata?: ChainMap<ChainMetadata>;
  evmProviderFactory?: (rpcUrl: string) => providers.Provider;
  registerTxRetryDelayMs?: number;
  erc20ContractFactory?: Erc20ContractFactory;
}

export interface SwapsXyzBridgeRoute {
  // Telemetry only. execute() always re-quotes before signing.
  actionResponse: SwapsXyzActionResponse;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function transactionValue(tx: unknown, context: string): bigint {
  assert(isRecord(tx), `${context} transaction is missing`);
  const value = tx.value;
  assert(
    value === undefined || typeof value === 'string',
    `${context} transaction value is invalid`,
  );
  return value === undefined || value === '' ? 0n : BigInt(value);
}

function transactionSelector(data: string, context: string): string {
  assert(
    /^0x[0-9a-fA-F]+$/.test(data) && data.length >= 10 && data.length % 2 === 0,
    `${context} transaction calldata is invalid`,
  );
  return data.slice(2, 10).toLowerCase();
}

export class SwapsXyzBridge implements IExternalBridge {
  readonly externalBridgeId = ExternalBridgeType.SwapsXyz;
  readonly logger: Logger;

  private readonly client: SwapsXyzClient;
  private readonly config: SwapsXyzBridgeConfig;
  private readonly chainMetadataByChainId = new Map<number, ChainMetadata>();
  private readonly tokenDecimalsCache = new Map<string, Promise<number>>();
  private readonly evmProviderFactory: (rpcUrl: string) => providers.Provider;
  private readonly registerTxRetryDelayMs: number;
  // Prevent source-account races when movements share a source in one cycle.
  private _executeLock: Promise<void> = Promise.resolve();

  constructor(
    config: SwapsXyzBridgeConfig,
    logger: Logger,
    client?: SwapsXyzClient,
  ) {
    this.config = config;
    assert(
      config.maxQuoteLossBps === undefined ||
        (Number.isInteger(config.maxQuoteLossBps) &&
          config.maxQuoteLossBps >= 0 &&
          config.maxQuoteLossBps <= Number(BPS_DENOMINATOR)),
      'maxQuoteLossBps must be an integer between 0 and 10000',
    );
    this.logger = logger;
    const defaultSlippageBps = this.getSlippageBps();
    this.client =
      client ??
      new SwapsXyzClient(
        {
          apiKey: config.apiKey,
          apiUrl: config.apiUrl,
          defaultSlippageBps,
        },
        logger,
      );
    this.evmProviderFactory =
      config.evmProviderFactory ??
      ((rpcUrl) => new providers.StaticJsonRpcProvider(rpcUrl));
    this.registerTxRetryDelayMs =
      config.registerTxRetryDelayMs ?? REGISTER_TX_RETRY_DELAY_MS;

    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
        if (metadata.chainId !== undefined && isEVMLike(metadata.protocol)) {
          this.chainMetadataByChainId.set(Number(metadata.chainId), metadata);
        }
      }
    }
  }

  getNativeTokenAddress(): string {
    return NATIVE_TOKEN_ADDRESS;
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<SwapsXyzBridgeRoute>> {
    this.validateQuoteParams(params);

    try {
      const response = await this.client.getAction(
        this.buildActionRequest(params),
      );
      return this.toBridgeQuote(params, response);
    } catch (error) {
      if (
        params.toAmount !== undefined &&
        error instanceof SwapsXyzRequestError &&
        error.code === 'UNSUPPORTED_SWAP_DIRECTION'
      ) {
        return this.quoteExactOutWithForwardFallback(params);
      }
      throw error;
    }
  }

  execute(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const execution = this._executeLock.then(() =>
      this.executeUnlocked(quote, privateKeys),
    );
    this._executeLock = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
    transferId?: string,
  ): Promise<BridgeTransferStatus> {
    let response: SwapsXyzStatusResponse | undefined;
    let statusError: unknown;
    const statusRequest = {
      txHash,
      chainId: fromChain,
      ...(transferId === undefined ? {} : { txId: transferId }),
    };
    try {
      response = await this.client.getStatus(statusRequest);
    } catch (error) {
      statusError = error;
    }

    // registerTxs is idempotent. Retrying it here heals transient registration
    // outages without re-broadcasting the source transaction.
    if (
      transferId !== undefined &&
      (response === undefined ||
        response.status.toLowerCase() === 'not yet created') &&
      (await this.registerTransaction(transferId, txHash))
    ) {
      try {
        response = await this.client.getStatus(statusRequest);
      } catch (error) {
        statusError = error;
        response = undefined;
      }
    }

    if (response === undefined) {
      if (isSwapsXyzNotFoundError(statusError)) {
        return { status: 'not_found' };
      }
      this.logger.warn(
        { txHash, transferId, error: statusError },
        'Failed to get swaps.xyz status',
      );
      throw statusError instanceof Error
        ? statusError
        : new Error('Failed to get swaps.xyz status');
    }
    return this.toBridgeTransferStatus(response, txHash, fromChain, toChain);
  }

  private toBridgeTransferStatus(
    response: SwapsXyzStatusResponse,
    txHash: string,
    fromChain: number,
    toChain: number,
  ): BridgeTransferStatus {
    // The API's chainId param is advisory: a hash registered on a different
    // chain is still returned. Such an entry is not our transfer.
    if (
      response.srcChainId !== undefined &&
      response.srcChainId !== fromChain
    ) {
      this.logger.warn(
        { txHash, fromChain, responseSrcChainId: response.srcChainId },
        'swaps.xyz status srcChainId does not match requested chain',
      );
      return { status: 'not_found' };
    }
    if (response.dstChainId !== toChain) {
      this.logger.warn(
        { txHash, toChain, responseDstChainId: response.dstChainId },
        'swaps.xyz status dstChainId does not match requested chain',
      );
      return { status: 'not_found' };
    }
    const rawStatus = response.status;

    switch (rawStatus.toLowerCase()) {
      case 'success':
      case 'completed':
        return {
          status: 'complete',
          receivingTxHash: response.dstTxHash ?? '',
          receivedAmount: BigInt(
            response.actionResponse?.amountOut.amount ?? '0',
          ),
        };
      case 'failed':
        return {
          status: 'failed',
          error: 'swaps.xyz reported transfer failed',
        };
      case 'refunded':
        return { status: 'failed', error: 'refunded' };
      case 'requires refund':
        return {
          status: 'failed',
          error: 'requires refund (claim via swaps.xyz)',
        };
      case 'expired':
        return { status: 'failed', error: 'swaps.xyz transfer expired' };
      default:
        return { status: 'pending', substatus: rawStatus };
    }
  }

  private validateQuoteParams(params: BridgeQuoteParams): void {
    if (params.fromAmount !== undefined && params.toAmount !== undefined) {
      throw new Error(
        'Cannot specify both fromAmount and toAmount - provide exactly one',
      );
    }
    if (params.fromAmount === undefined && params.toAmount === undefined) {
      throw new Error('Must specify either fromAmount or toAmount');
    }
    assert(
      params.fromAmount === undefined || params.fromAmount > 0n,
      'fromAmount must be positive',
    );
    assert(
      params.toAmount === undefined || params.toAmount > 0n,
      'toAmount must be positive',
    );
  }

  private buildActionRequest(params: BridgeQuoteParams): SwapsXyzActionRequest {
    const amount = params.fromAmount ?? params.toAmount;
    assert(amount !== undefined, 'Must specify either fromAmount or toAmount');
    return {
      actionType: 'swap-action',
      sender: params.fromAddress,
      recipient: params.toAddress ?? params.fromAddress,
      srcChainId: params.fromChain,
      dstChainId: params.toChain,
      srcToken: params.fromToken,
      dstToken: params.toToken,
      slippage: this.getSlippageBps(params.slippage),
      amount: amount.toString(),
      swapDirection:
        params.fromAmount !== undefined
          ? 'exact-amount-in'
          : 'exact-amount-out',
    };
  }

  private getSlippageBps(slippage?: number): number {
    return Math.round(
      (slippage ?? this.config.defaultSlippage ?? DEFAULT_SLIPPAGE) * 10_000,
    );
  }

  private async quoteExactOutWithForwardFallback(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<SwapsXyzBridgeRoute>> {
    const toAmount = params.toAmount;
    assert(toAmount !== undefined, 'Reverse quote requires toAmount');
    const slippageBps = this.getSlippageBps(params.slippage);
    const [sourceDecimals, destinationDecimals] = await Promise.all([
      this.getTokenDecimals(params.fromChain, params.fromToken),
      this.getTokenDecimals(params.toChain, params.toToken),
    ]);
    let fromAmount = ceilDiv(
      toAmount * 10n ** BigInt(sourceDecimals),
      10n ** BigInt(destinationDecimals),
    );
    fromAmount =
      (fromAmount *
        (BPS_DENOMINATOR + BigInt(slippageBps) + REVERSE_QUOTE_HEADROOM_BPS)) /
      BPS_DENOMINATOR;

    let lastAmountOutMin = 0n;
    for (let attempt = 1; attempt <= REVERSE_QUOTE_ATTEMPTS; attempt++) {
      const forwardParams: BridgeQuoteParams = {
        ...params,
        fromAmount,
        toAmount: undefined,
      };
      const response = await this.client.getAction(
        this.buildActionRequest(forwardParams),
      );
      lastAmountOutMin = BigInt(response.amountOutMin.amount);
      this.logger.debug(
        {
          attempt,
          fromAmount: fromAmount.toString(),
          amountOutMin: lastAmountOutMin.toString(),
          requestedToAmount: toAmount.toString(),
        },
        'swaps.xyz reverse quote forward fallback attempt',
      );
      if (lastAmountOutMin >= toAmount) {
        return this.toBridgeQuote(forwardParams, response);
      }
      assert(
        lastAmountOutMin > 0n,
        'SwapsXyzBridge reverse quote fallback returned zero amountOutMin',
      );
      fromAmount = ceilDiv(fromAmount * toAmount, lastAmountOutMin) + 1n;
    }

    throw new Error(
      `SwapsXyzBridge reverse quote fallback exhausted after ${REVERSE_QUOTE_ATTEMPTS} attempts; last amountOutMin ${lastAmountOutMin.toString()} was short of requested ${toAmount.toString()}`,
    );
  }

  private getTokenDecimals(chainId: number, token: string): Promise<number> {
    const cacheKey = `${chainId}:${token}`;
    const cached = this.tokenDecimalsCache.get(cacheKey);
    if (cached) return cached;

    const decimals = this.fetchTokenDecimals(chainId, token);
    this.tokenDecimalsCache.set(cacheKey, decimals);
    void decimals.catch(() => {
      if (this.tokenDecimalsCache.get(cacheKey) === decimals) {
        this.tokenDecimalsCache.delete(cacheKey);
      }
    });
    return decimals;
  }

  private async fetchTokenDecimals(
    chainId: number,
    token: string,
  ): Promise<number> {
    const metadata = this.chainMetadataByChainId.get(chainId);
    assert(
      metadata,
      `SwapsXyzBridge: no chain metadata configured for chainId ${chainId}`,
    );
    if (token.toLowerCase() === NATIVE_TOKEN_ADDRESS) {
      return metadata.nativeToken?.decimals ?? 18;
    }
    assert(
      isEVMLike(metadata.protocol),
      `SwapsXyzBridge: unsupported token decimals protocol ${metadata.protocol}`,
    );
    const rpcUrl = metadata.rpcUrls[0]?.http;
    assert(
      rpcUrl,
      `SwapsXyzBridge: no RPC URL configured for chainId ${chainId}`,
    );
    const provider = this.evmProviderFactory(rpcUrl);
    const tokenContract = new Contract(token, ERC20_DECIMALS_ABI, provider);
    return Number(await tokenContract.decimals());
  }

  private async toBridgeQuote(
    params: BridgeQuoteParams,
    response: SwapsXyzActionResponse,
  ): Promise<BridgeQuote<SwapsXyzBridgeRoute>> {
    let feeCosts = 0n;
    for (const fee of [
      response.protocolFee,
      response.applicationFee,
      response.bridgeFee,
    ]) {
      if (fee?.amount) feeCosts += BigInt(fee.amount);
    }

    const fromAmount = BigInt(
      (response.amountInMax ?? response.amountIn).amount,
    );
    const toAmountMin = BigInt(response.amountOutMin.amount);
    await this.validateQuoteLoss(params, response, fromAmount, toAmountMin);

    return {
      id: response.txId,
      tool: response.bridgeIds?.join('+') || 'swapsxyz',
      fromAmount,
      toAmount: BigInt(response.amountOut.amount),
      toAmountMin,
      executionDuration: response.estimatedTxTime ?? 0,
      gasCosts: 0n,
      feeCosts,
      route: { actionResponse: response },
      requestParams: params,
    };
  }

  private async executeUnlocked(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    const { fromChain, toChain } = quote.requestParams;
    const metadata = this.chainMetadataByChainId.get(fromChain);
    assert(
      metadata,
      `SwapsXyzBridge.execute: no chain metadata configured for chainId ${fromChain}`,
    );
    const rpcUrl = metadata.rpcUrls[0]?.http;
    assert(
      rpcUrl,
      `SwapsXyzBridge.execute: no RPC URL configured for chainId ${fromChain}`,
    );
    const privateKey = privateKeys[ProtocolType.Ethereum];
    assert(
      privateKey,
      'SwapsXyzBridge.execute requires an Ethereum (EVM) private key',
    );

    const provider = this.evmProviderFactory(rpcUrl);
    const signer = new Wallet(ensure0x(privateKey), provider);
    assert(
      this.addressesEqual(
        await signer.getAddress(),
        quote.requestParams.fromAddress,
        fromChain,
      ),
      'SwapsXyzBridge.execute signer does not match quote fromAddress',
    );

    const fresh = await this.client.getAction(
      this.buildActionRequest(quote.requestParams),
    );
    assert(isEvmTx(fresh.tx), 'SwapsXyzBridge.execute requires an EVM tx');
    this.validateActionResponse(fresh, quote, 'evm');

    if (fresh.requiresTokenApproval) {
      await approveErc20IfNeeded(
        signer,
        quote.requestParams.fromToken,
        fresh.tx.to,
        BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
        this.logger,
        { contractFactory: this.config.erc20ContractFactory },
      );
    }

    const txResponse = await signer.sendTransaction({
      to: fresh.tx.to,
      data: fresh.tx.data,
      value: fresh.tx.value ? BigNumber.from(fresh.tx.value) : undefined,
    });
    // Persistable tracking identity takes priority over waiting here: once a
    // source transaction is broadcast, receipt/status failures must not cause
    // the planner to send the same movement again.
    void this.registerIfRequired(fresh, txResponse.hash);
    return {
      txHash: txResponse.hash,
      fromChain,
      toChain,
      transferId: fresh.txId,
    };
  }

  private validateActionResponse(
    response: SwapsXyzActionResponse,
    quote: BridgeQuote,
    expectedVmId: 'evm',
  ): void {
    const params = quote.requestParams;
    assert(
      response.vmId === undefined || response.vmId === expectedVmId,
      `SwapsXyzBridge.execute vmId ${response.vmId} does not match ${expectedVmId}`,
    );
    if (response.tx.chainId !== undefined) {
      assert(
        response.tx.chainId === params.fromChain,
        `SwapsXyzBridge.execute tx chainId ${response.tx.chainId} does not match requested ${params.fromChain}`,
      );
    }
    if (response.amountIn.chainId !== undefined) {
      assert(
        response.amountIn.chainId === params.fromChain,
        `SwapsXyzBridge.execute amountIn chainId ${response.amountIn.chainId} does not match requested ${params.fromChain}`,
      );
    }
    if (response.amountOut.chainId !== undefined) {
      assert(
        response.amountOut.chainId === params.toChain,
        `SwapsXyzBridge.execute amountOut chainId ${response.amountOut.chainId} does not match requested ${params.toChain}`,
      );
    }
    if (response.amountIn.address !== undefined) {
      assert(
        this.addressesEqual(
          response.amountIn.address,
          params.fromToken,
          params.fromChain,
        ),
        `SwapsXyzBridge.execute amountIn token ${response.amountIn.address} does not match requested ${params.fromToken}`,
      );
    }
    if (response.amountOut.address !== undefined) {
      assert(
        this.addressesEqual(
          response.amountOut.address,
          params.toToken,
          params.toChain,
        ),
        `SwapsXyzBridge.execute amountOut token ${response.amountOut.address} does not match requested ${params.toToken}`,
      );
    }
    const tx = response.tx;
    assert(isEvmTx(tx), 'SwapsXyzBridge.execute EVM transaction is invalid');
    if (this.addressesEqual(tx.to, params.fromToken, params.fromChain)) {
      const selector = transactionSelector(
        tx.data,
        'SwapsXyzBridge.execute fresh',
      );
      assert(
        !UNSAFE_SOURCE_TOKEN_SELECTORS.has(selector),
        `SwapsXyzBridge.execute rejects direct source-token selector 0x${selector}`,
      );
    }

    const freshFromAmount = BigInt(
      (response.amountInMax ?? response.amountIn).amount,
    );
    assert(
      freshFromAmount <= quote.fromAmount,
      `SwapsXyzBridge.execute fresh input ${freshFromAmount} exceeds accepted input cap ${quote.fromAmount}`,
    );
    const freshToAmountMin = BigInt(response.amountOutMin.amount);
    assert(
      freshToAmountMin >= quote.toAmountMin,
      `SwapsXyzBridge.execute fresh minimum output ${freshToAmountMin} is below accepted minimum ${quote.toAmountMin}`,
    );
    assert(
      isRecord(quote.route) && isRecord(quote.route.actionResponse),
      'SwapsXyzBridge.execute accepted action response is missing',
    );
    const acceptedTx = quote.route.actionResponse.tx;
    assert(
      isEvmTx(acceptedTx),
      'SwapsXyzBridge.execute accepted EVM transaction is invalid',
    );
    assert(
      this.addressesEqual(tx.to, acceptedTx.to, params.fromChain),
      `SwapsXyzBridge.execute fresh target ${tx.to} does not match accepted target ${acceptedTx.to}`,
    );
    assert(
      transactionSelector(tx.data, 'SwapsXyzBridge.execute fresh') ===
        transactionSelector(acceptedTx.data, 'SwapsXyzBridge.execute accepted'),
      'SwapsXyzBridge.execute fresh calldata selector does not match accepted selector',
    );
    const freshValue = transactionValue(
      response.tx,
      'SwapsXyzBridge.execute fresh',
    );
    const acceptedValue = transactionValue(
      quote.route.actionResponse.tx,
      'SwapsXyzBridge.execute accepted',
    );
    assert(
      freshValue >= 0n && freshValue <= acceptedValue,
      `SwapsXyzBridge.execute fresh native value ${freshValue} exceeds accepted native value ${acceptedValue}`,
    );
    if (
      !this.addressesEqual(
        params.fromToken,
        NATIVE_TOKEN_ADDRESS,
        params.fromChain,
      )
    ) {
      assert(
        acceptedValue === 0n && freshValue === 0n,
        'SwapsXyzBridge.execute ERC20 routes must not send native value',
      );
    }
  }

  private async validateQuoteLoss(
    params: BridgeQuoteParams,
    response: SwapsXyzActionResponse,
    fromAmount: bigint,
    toAmountMin: bigint,
  ): Promise<void> {
    const maxQuoteLossBps = this.config.maxQuoteLossBps;
    if (maxQuoteLossBps === undefined) return;

    const [sourceDecimals, destinationDecimals] = await Promise.all([
      response.amountInMax?.decimals ??
        response.amountIn.decimals ??
        this.getTokenDecimals(params.fromChain, params.fromToken),
      response.amountOutMin.decimals ??
        response.amountOut.decimals ??
        this.getTokenDecimals(params.toChain, params.toToken),
    ]);
    assert(
      sourceDecimals <= 255 && destinationDecimals <= 255,
      'swaps.xyz quote token decimals must be at most 255',
    );
    const commonDecimals = Math.max(sourceDecimals, destinationDecimals);
    const normalizedFromAmount =
      fromAmount * 10n ** BigInt(commonDecimals - sourceDecimals);
    const normalizedToAmountMin =
      toAmountMin * 10n ** BigInt(commonDecimals - destinationDecimals);
    const lossBps =
      normalizedToAmountMin >= normalizedFromAmount
        ? 0n
        : ceilDiv(
            (normalizedFromAmount - normalizedToAmountMin) * BPS_DENOMINATOR,
            normalizedFromAmount,
          );
    assert(
      lossBps <= BigInt(maxQuoteLossBps),
      `swaps.xyz quote loss ${lossBps} bps exceeds configured maximum ${maxQuoteLossBps} bps`,
    );
  }

  private addressesEqual(
    left: string,
    right: string,
    _chainId: number,
  ): boolean {
    if (left.startsWith('0x') && right.startsWith('0x')) {
      return left.toLowerCase() === right.toLowerCase();
    }
    return left === right;
  }

  private async registerIfRequired(
    response: SwapsXyzActionResponse,
    txHash: string,
  ): Promise<void> {
    if (response.requiresRegisterTransaction !== true) return;
    await this.registerTransaction(response.txId, txHash);
  }

  private async registerTransaction(
    txId: string,
    txHash: string,
  ): Promise<boolean> {
    try {
      await retryAsync(
        async () => {
          const results = await this.client.registerTxs([{ txId, txHash }]);
          const failed = results.find((result) => !result.success);
          if (failed) {
            throw new Error(
              `swaps.xyz registerTxs failed: ${failed.error ?? 'unknown error'}`,
            );
          }
        },
        3,
        this.registerTxRetryDelayMs,
      );
      return true;
    } catch (error) {
      this.logger.error(
        { txId, txHash, error },
        'Failed to register swaps.xyz transaction',
      );
      return false;
    }
  }
}
