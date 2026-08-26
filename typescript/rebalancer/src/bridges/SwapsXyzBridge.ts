import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { TronWallet } from '@hyperlane-xyz/tron-sdk/runtime';
import {
  ProtocolType,
  assert,
  ensure0x,
  isEVMLike,
  retryAsync,
} from '@hyperlane-xyz/utils';
import { BigNumber, Contract, Wallet, providers, utils } from 'ethers';
import type { Logger } from 'pino';
import { TronWeb } from 'tronweb';

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
  isTronTx,
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
const ERC20_TRANSFER_INTERFACE = new utils.Interface([
  'function transfer(address recipient, uint256 amount) returns (bool)',
]);
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
  tronWalletFactory?: (privateKey: string, rpcUrl: string) => Wallet;
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
  private readonly tronWalletFactory: (
    privateKey: string,
    rpcUrl: string,
  ) => Wallet;
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
    this.tronWalletFactory =
      config.tronWalletFactory ??
      ((privateKey, rpcUrl) => new TronWallet(privateKey, rpcUrl));
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
      sender: this.formatAddressForApi(params.fromChain, params.fromAddress),
      recipient: this.formatAddressForApi(
        params.toChain,
        params.toAddress ?? params.fromAddress,
      ),
      srcChainId: params.fromChain,
      dstChainId: params.toChain,
      srcToken: this.formatAddressForApi(params.fromChain, params.fromToken),
      dstToken: this.formatAddressForApi(params.toChain, params.toToken),
      slippage: this.getSlippageBps(params.slippage),
      amount: amount.toString(),
      swapDirection:
        params.fromAmount !== undefined
          ? 'exact-amount-in'
          : 'exact-amount-out',
    };
  }

  private formatAddressForApi(chainId: number, address: string): string {
    const protocol = this.chainMetadataByChainId.get(chainId)?.protocol;
    if (protocol === ProtocolType.Tron) {
      return TronWeb.address.fromHex(`41${this.tronAddressHex20(address)}`);
    }
    if (protocol === ProtocolType.Ethereum && address.startsWith('T')) {
      return this.tronAddressToEvm(address);
    }
    return address;
  }

  private tronAddressHex20(address: string): string {
    if (address.startsWith('T')) {
      assert(
        TronWeb.isAddress(address),
        `SwapsXyzBridge: invalid Tron address ${address}`,
      );
      const hex = TronWeb.address.toHex(address);
      assert(
        /^41[0-9a-fA-F]{40}$/.test(hex),
        `SwapsXyzBridge: invalid Tron address ${address}`,
      );
      return hex.slice(2).toLowerCase();
    }

    let hex = address.startsWith('0x') ? address.slice(2) : address;
    if (/^41[0-9a-fA-F]{40}$/.test(hex)) hex = hex.slice(2);
    assert(
      /^[0-9a-fA-F]{40}$/.test(hex) && TronWeb.isAddress(`41${hex}`),
      `SwapsXyzBridge: invalid Tron address ${address}`,
    );
    return hex.toLowerCase();
  }

  private tronAddressToEvm(address: string): string {
    return ensure0x(this.tronAddressHex20(address));
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
    const tokenAddress =
      metadata.protocol === ProtocolType.Tron
        ? this.tronAddressToEvm(token)
        : token;
    const tokenContract = new Contract(
      tokenAddress,
      ERC20_DECIMALS_ABI,
      provider,
    );
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
    if (metadata.protocol === ProtocolType.Tron) {
      return this.executeTron(quote, privateKeys, rpcUrl);
    }

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
    const freshTx = fresh.tx;
    assert(isEvmTx(freshTx), 'SwapsXyzBridge.execute requires an EVM tx');
    this.validateActionResponse(fresh, quote, 'evm');

    if (fresh.requiresTokenApproval) {
      await approveErc20IfNeeded(
        signer,
        quote.requestParams.fromToken,
        freshTx.to,
        BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
        this.logger,
        { contractFactory: this.config.erc20ContractFactory },
      );
    }

    const txResponse = await signer.sendTransaction({
      to: freshTx.to,
      data: freshTx.data,
      value: freshTx.value ? BigNumber.from(freshTx.value) : undefined,
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

  private async executeTron(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    rpcUrl: string,
  ): Promise<BridgeTransferResult> {
    const { fromChain, toChain } = quote.requestParams;
    const privateKey = privateKeys[ProtocolType.Tron];
    assert(
      privateKey,
      'SwapsXyzBridge.execute requires a Tron private key for Tron-source routes',
    );
    const signer = this.tronWalletFactory(ensure0x(privateKey), rpcUrl);
    assert(
      this.addressesEqual(
        await signer.getAddress(),
        quote.requestParams.fromAddress,
        fromChain,
      ),
      'SwapsXyzBridge.execute Tron signer does not match quote fromAddress',
    );

    const fresh = await this.client.getAction(
      this.buildActionRequest(quote.requestParams),
    );
    const freshTx = fresh.tx;
    assert(isTronTx(freshTx), 'SwapsXyzBridge.execute requires a Tron tx');
    assert(
      fresh.requiresRegisterTransaction === true,
      'SwapsXyzBridge.execute Tron actions must require transaction registration',
    );
    this.validateActionResponse(fresh, quote, 'alt-vm');

    const transactionTo = this.tronAddressToEvm(freshTx.to);
    const sourceToken = this.tronAddressToEvm(quote.requestParams.fromToken);
    let txResponse: providers.TransactionResponse;
    if (freshTx.toExtra === null) {
      assert(
        !fresh.requiresTokenApproval,
        'SwapsXyzBridge.execute direct Tron transfers must not require token approval',
      );
      const transferAmount = BigNumber.from(freshTx.value);
      if (
        this.addressesEqual(
          quote.requestParams.fromToken,
          NATIVE_TOKEN_ADDRESS,
          fromChain,
        )
      ) {
        txResponse = await signer.sendTransaction({
          to: transactionTo,
          value: transferAmount,
        });
      } else {
        // swaps.xyz represents Tron TRC20 deposits as a direct token transfer:
        // `to` is the deposit recipient and `value` is the token amount.
        txResponse = await signer.sendTransaction({
          to: sourceToken,
          data: ERC20_TRANSFER_INTERFACE.encodeFunctionData('transfer', [
            transactionTo,
            transferAmount,
          ]),
          value: 0,
        });
      }
    } else {
      if (fresh.requiresTokenApproval) {
        await approveErc20IfNeeded(
          signer,
          sourceToken,
          transactionTo,
          BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
          this.logger,
          { contractFactory: this.config.erc20ContractFactory },
        );
      }

      txResponse = await signer.sendTransaction({
        to: transactionTo,
        data: ensure0x(freshTx.toExtra),
        value: BigNumber.from(freshTx.value),
      });
    }
    const txHash = ensure0x(txResponse.hash);
    // Persist the broadcast identity before confirmation. Registration is
    // best-effort here and retried durably by getStatus().
    void this.registerIfRequired(fresh, txHash);
    return {
      txHash,
      fromChain,
      toChain,
      transferId: fresh.txId,
    };
  }

  private validateActionResponse(
    response: SwapsXyzActionResponse,
    quote: BridgeQuote,
    expectedVmId: 'evm' | 'alt-vm',
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
    const isExpectedTransaction =
      expectedVmId === 'evm' ? isEvmTx(tx) : isTronTx(tx);
    assert(
      isExpectedTransaction,
      `SwapsXyzBridge.execute ${expectedVmId} transaction is invalid`,
    );
    if (this.addressesEqual(tx.to, params.fromToken, params.fromChain)) {
      const sourceTokenData = isTronTx(tx) ? tx.toExtra : tx.data;
      assert(
        sourceTokenData !== null,
        'SwapsXyzBridge.execute rejects direct Tron deposits to the source token',
      );
      const selector = transactionSelector(
        ensure0x(sourceTokenData),
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
      isEvmTx(acceptedTx) || isTronTx(acceptedTx),
      'SwapsXyzBridge.execute accepted transaction is invalid',
    );
    const isExpectedAcceptedTransaction =
      expectedVmId === 'evm' ? isEvmTx(acceptedTx) : isTronTx(acceptedTx);
    assert(
      isExpectedAcceptedTransaction,
      `SwapsXyzBridge.execute accepted ${expectedVmId} transaction is invalid`,
    );
    const isDirectTronTransfer = isTronTx(tx) && tx.toExtra === null;
    const isAcceptedDirectTronTransfer =
      isTronTx(acceptedTx) && acceptedTx.toExtra === null;
    if (!isDirectTronTransfer || !isAcceptedDirectTronTransfer) {
      assert(
        this.addressesEqual(tx.to, acceptedTx.to, params.fromChain),
        `SwapsXyzBridge.execute fresh target ${tx.to} does not match accepted target ${acceptedTx.to}`,
      );
    } else {
      // Tron direct-deposit addresses are unique per action response. Bind the
      // refresh to the accepted bridge rail while strictly validating both
      // deposit targets.
      const sourceToken = this.tronAddressToEvm(params.fromToken).toLowerCase();
      const freshTarget = this.tronAddressToEvm(tx.to).toLowerCase();
      const acceptedTarget = this.tronAddressToEvm(acceptedTx.to).toLowerCase();
      assert(
        freshTarget !== sourceToken && acceptedTarget !== sourceToken,
        'SwapsXyzBridge.execute rejects direct Tron deposits to the source token',
      );
      const freshTool = response.bridgeIds?.join('+') || 'swapsxyz';
      assert(
        freshTool === quote.tool,
        `SwapsXyzBridge.execute fresh bridge ${freshTool} does not match accepted bridge ${quote.tool}`,
      );
    }
    const freshData = isTronTx(tx) ? tx.toExtra : tx.data;
    const acceptedData = isTronTx(acceptedTx)
      ? acceptedTx.toExtra
      : acceptedTx.data;
    assert(
      (freshData === null) === (acceptedData === null),
      'SwapsXyzBridge.execute fresh transaction kind does not match accepted transaction',
    );
    if (freshData !== null && acceptedData !== null) {
      assert(
        transactionSelector(
          ensure0x(freshData),
          'SwapsXyzBridge.execute fresh',
        ) ===
          transactionSelector(
            ensure0x(acceptedData),
            'SwapsXyzBridge.execute accepted',
          ),
        'SwapsXyzBridge.execute fresh calldata selector does not match accepted selector',
      );
    }
    if (isTronTx(tx) && tx.toExtra === null) {
      assert(
        isTronTx(acceptedTx) && acceptedTx.toExtra === null,
        'SwapsXyzBridge.execute accepted direct Tron transaction is invalid',
      );
      assert(
        response.requiresTokenApproval === false,
        'SwapsXyzBridge.execute direct Tron transfers must not require token approval',
      );
      const freshTransferAmount = BigInt(tx.value);
      const acceptedTransferAmount = BigInt(acceptedTx.value);
      assert(
        freshTransferAmount === freshFromAmount,
        `SwapsXyzBridge.execute Tron transfer amount ${freshTransferAmount} does not match fresh input ${freshFromAmount}`,
      );
      assert(
        acceptedTransferAmount === quote.fromAmount,
        `SwapsXyzBridge.execute accepted Tron transfer amount ${acceptedTransferAmount} does not match accepted input ${quote.fromAmount}`,
      );
      return;
    }
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
    chainId: number,
  ): boolean {
    if (
      this.chainMetadataByChainId.get(chainId)?.protocol === ProtocolType.Tron
    ) {
      return this.tronAddressHex20(left) === this.tronAddressHex20(right);
    }
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
