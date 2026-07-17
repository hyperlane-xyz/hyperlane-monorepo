import type { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
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
  DEFAULT_RECEIPT_TIMEOUT_MS,
  ReceiptWaitTimeoutError,
  adaptNativeReceiptTimeout,
} from '../utils/receiptTimeout.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';

import { approveErc20IfNeeded } from './erc20Approve.js';
import {
  SwapsXyzClient,
  SwapsXyzRequestError,
  isEvmTx,
  isSolanaTx,
  type SwapsXyzActionRequest,
  type SwapsXyzActionResponse,
} from './SwapsXyzClient.js';

const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_SLIPPAGE = 0.005;
const REVERSE_QUOTE_ATTEMPTS = 4;
const REVERSE_QUOTE_HEADROOM_BPS = 30n;
const BPS_DENOMINATOR = 10_000n;
const ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'];
const SOLANA_CONFIRM_POLL_MS = 2_000;
const SOLANA_CONFIRM_TIMEOUT_MS = 90_000;
const REGISTER_TX_RETRY_DELAY_MS = 2_000;

export interface SwapsXyzBridgeConfig {
  apiKey: string;
  apiUrl?: string;
  defaultSlippage?: number;
  chainMetadata?: ChainMap<ChainMetadata>;
  evmProviderFactory?: (rpcUrl: string) => providers.Provider;
  solanaConnectionFactory?: (rpcUrl: string) => Connection;
  solanaConfirmPollMs?: number;
  solanaConfirmTimeoutMs?: number;
  registerTxRetryDelayMs?: number;
}

export interface SwapsXyzBridgeRoute {
  // Telemetry only. execute() always re-quotes before signing.
  actionResponse: SwapsXyzActionResponse;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export class SwapsXyzBridge implements IExternalBridge {
  readonly externalBridgeId = ExternalBridgeType.SwapsXyz;
  readonly logger: Logger;

  private readonly client: SwapsXyzClient;
  private readonly config: SwapsXyzBridgeConfig;
  private readonly chainMetadataByChainId = new Map<number, ChainMetadata>();
  private readonly tokenDecimalsCache = new Map<string, Promise<number>>();
  private readonly evmProviderFactory: (rpcUrl: string) => providers.Provider;
  private readonly solanaConnectionFactory: (rpcUrl: string) => Connection;
  private readonly solanaConfirmPollMs: number;
  private readonly solanaConfirmTimeoutMs: number;
  private readonly registerTxRetryDelayMs: number;
  // Prevent source-account races when movements share a source in one cycle.
  private _executeLock: Promise<void> = Promise.resolve();

  constructor(
    config: SwapsXyzBridgeConfig,
    logger: Logger,
    client?: SwapsXyzClient,
  ) {
    this.config = config;
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
    this.solanaConnectionFactory =
      config.solanaConnectionFactory ??
      ((rpcUrl) => new Connection(rpcUrl, 'confirmed'));
    this.solanaConfirmPollMs =
      config.solanaConfirmPollMs ?? SOLANA_CONFIRM_POLL_MS;
    this.solanaConfirmTimeoutMs =
      config.solanaConfirmTimeoutMs ?? SOLANA_CONFIRM_TIMEOUT_MS;
    this.registerTxRetryDelayMs =
      config.registerTxRetryDelayMs ?? REGISTER_TX_RETRY_DELAY_MS;

    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
        // Numeric chain IDs can collide across protocols. Index EVM-like
        // metadata by chain ID and Sealevel metadata by Hyperlane domain ID.
        // Never let Sealevel domain IDs overwrite EVM chain IDs.
        if (
          metadata.protocol === ProtocolType.Sealevel &&
          !this.chainMetadataByChainId.has(metadata.domainId)
        ) {
          this.chainMetadataByChainId.set(metadata.domainId, metadata);
        }
      }
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
    _toChain: number,
  ): Promise<BridgeTransferStatus> {
    try {
      const response = await this.client.getStatus({
        txHash,
        chainId: fromChain,
      });
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
        default:
          return { status: 'pending', substatus: rawStatus };
      }
    } catch (error) {
      this.logger.warn({ txHash, error }, 'Failed to get swaps.xyz status');
      return { status: 'not_found' };
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
    if (metadata.protocol === ProtocolType.Sealevel) {
      const rpcUrl = metadata.rpcUrls[0]?.http;
      assert(
        rpcUrl,
        `SwapsXyzBridge: no RPC URL configured for chainId ${chainId}`,
      );
      const supply = await this.solanaConnectionFactory(rpcUrl).getTokenSupply(
        new PublicKey(token),
      );
      return supply.value.decimals;
    }
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

  private toBridgeQuote(
    params: BridgeQuoteParams,
    response: SwapsXyzActionResponse,
  ): BridgeQuote<SwapsXyzBridgeRoute> {
    let feeCosts = 0n;
    for (const fee of [
      response.protocolFee,
      response.applicationFee,
      response.bridgeFee,
    ]) {
      if (fee?.amount) feeCosts += BigInt(fee.amount);
    }

    return {
      id: response.txId,
      tool: response.bridgeIds?.join('+') || 'swapsxyz',
      fromAmount: BigInt((response.amountInMax ?? response.amountIn).amount),
      toAmount: BigInt(response.amountOut.amount),
      toAmountMin: BigInt(response.amountOutMin.amount),
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
    if (metadata.protocol === ProtocolType.Sealevel) {
      return this.executeSolana(quote, privateKeys, rpcUrl);
    }
    const privateKey = privateKeys[ProtocolType.Ethereum];
    assert(
      privateKey,
      'SwapsXyzBridge.execute requires an Ethereum (EVM) private key',
    );

    const fresh = await this.client.getAction(
      this.buildActionRequest(quote.requestParams),
    );
    assert(isEvmTx(fresh.tx), 'SwapsXyzBridge.execute requires an EVM tx');
    this.validateActionResponse(fresh, quote.requestParams, 'evm');

    const provider = this.evmProviderFactory(rpcUrl);
    const signer = new Wallet(ensure0x(privateKey), provider);
    if (fresh.requiresTokenApproval) {
      await approveErc20IfNeeded(
        signer,
        quote.requestParams.fromToken,
        fresh.tx.to,
        BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
        this.logger,
      );
    }

    const txResponse = await signer.sendTransaction({
      to: fresh.tx.to,
      data: fresh.tx.data,
      value: fresh.tx.value ? BigNumber.from(fresh.tx.value) : undefined,
    });
    const receipt = await adaptNativeReceiptTimeout(
      provider.waitForTransaction(
        txResponse.hash,
        1,
        DEFAULT_RECEIPT_TIMEOUT_MS,
      ),
      {
        txHash: txResponse.hash,
        operation: 'swaps.xyz bridge',
        timeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
        role: 'primary',
      },
    );
    if (receipt.status === 0) {
      throw new Error(
        `SwapsXyzBridge.execute transaction reverted: ${txResponse.hash}`,
      );
    }

    await this.registerIfRequired(fresh, txResponse.hash);
    return {
      txHash: txResponse.hash,
      fromChain,
      toChain,
      transferId: fresh.txId,
    };
  }

  private async executeSolana(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    rpcUrl: string,
  ): Promise<BridgeTransferResult> {
    const { fromChain, toChain } = quote.requestParams;
    const rawKey = privateKeys[ProtocolType.Sealevel];
    assert(
      rawKey,
      'SwapsXyzBridge.execute requires a Sealevel private key for Solana-source routes',
    );
    const keypair = Keypair.fromSecretKey(parseSolanaPrivateKey(rawKey));

    const fresh = await this.client.getAction(
      this.buildActionRequest(quote.requestParams),
    );
    assert(isSolanaTx(fresh.tx), 'SwapsXyzBridge.execute requires a Solana tx');
    this.validateActionResponse(fresh, quote.requestParams, 'solana');
    if (fresh.tx.payer !== undefined) {
      const signerAddress = keypair.publicKey.toBase58();
      assert(
        fresh.tx.payer === signerAddress,
        `SwapsXyzBridge.execute Solana payer ${fresh.tx.payer} does not match signer ${signerAddress}`,
      );
    }

    const raw = Buffer.from(fresh.tx.base64Tx, 'base64');
    let signed: Uint8Array;
    try {
      const vtx = VersionedTransaction.deserialize(raw);
      vtx.sign([keypair]);
      signed = vtx.serialize();
    } catch {
      const ltx = Transaction.from(raw);
      ltx.partialSign(keypair);
      signed = ltx.serialize();
    }

    const connection = this.solanaConnectionFactory(rpcUrl);
    const signature = await connection.sendRawTransaction(signed, {
      skipPreflight: false,
      maxRetries: 5,
    });
    await this.confirmSolanaTransaction(connection, signature);
    await this.registerIfRequired(fresh, signature);

    return {
      txHash: signature,
      fromChain,
      toChain,
      transferId: fresh.txId,
    };
  }

  private async confirmSolanaTransaction(
    connection: Connection,
    signature: string,
  ): Promise<void> {
    const deadline = Date.now() + this.solanaConfirmTimeoutMs;
    for (;;) {
      const statuses = await connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];
      if (status?.err !== null && status?.err !== undefined) {
        throw new Error(
          `SwapsXyzBridge.execute Solana transaction ${signature} failed confirmation: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status?.err === null &&
        (status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized')
      ) {
        return;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(this.solanaConfirmPollMs, remainingMs)),
      );
    }

    // Funds may still land; the next planner cycle re-reads balances, bounding
    // double-send exposure to one cycle.
    throw new ReceiptWaitTimeoutError({
      txHash: signature,
      operation: 'solana sendRawTransaction confirm',
      timeoutMs: this.solanaConfirmTimeoutMs,
    });
  }

  private validateActionResponse(
    response: SwapsXyzActionResponse,
    params: BridgeQuoteParams,
    expectedVmId: 'evm' | 'solana',
  ): void {
    assert(
      response.vmId === undefined || response.vmId === expectedVmId,
      `SwapsXyzBridge.execute vmId ${response.vmId} does not match ${expectedVmId}`,
    );
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
        this.addressesEqual(response.amountIn.address, params.fromToken),
        `SwapsXyzBridge.execute amountIn token ${response.amountIn.address} does not match requested ${params.fromToken}`,
      );
    }
    if (response.amountOut.address !== undefined) {
      assert(
        this.addressesEqual(response.amountOut.address, params.toToken),
        `SwapsXyzBridge.execute amountOut token ${response.amountOut.address} does not match requested ${params.toToken}`,
      );
    }
  }

  private addressesEqual(left: string, right: string): boolean {
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
    try {
      await retryAsync(
        async () => {
          const results = await this.client.registerTxs([
            { txId: response.txId, txHash },
          ]);
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
    } catch (error) {
      this.logger.error(
        { txId: response.txId, txHash, error },
        'Failed to register swaps.xyz transaction after broadcast',
      );
    }
  }
}
