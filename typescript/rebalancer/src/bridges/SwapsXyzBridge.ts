import {
  type ChainMap,
  type ChainMetadata,
  submitEvmLikeTransaction,
} from '@hyperlane-xyz/sdk';
import {
  TronJsonRpcProvider,
  TronWallet,
} from '@hyperlane-xyz/tron-sdk/runtime';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  type AccountInfo,
  type AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  type SimulatedTransactionAccountInfo,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ProtocolType,
  TransactionSubmission,
  assert,
  bufferToBase58,
  ensure0x,
  isEVMLike,
  sleep,
} from '@hyperlane-xyz/utils';
import { BigNumber, Contract, Wallet, providers, utils } from 'ethers';
import type { Logger } from 'pino';
import { TronWeb } from 'tronweb';

import {
  DEFAULT_MAX_SOLANA_TRANSACTION_FEE_LAMPORTS,
  DEFAULT_SOLANA_TRANSACTION_FEE_WARNING_LAMPORTS,
  ExternalBridgeType,
} from '../config/types.js';
import type {
  BridgeExecutionOptions,
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import { minimumOutputForLoss } from '../utils/quoteBudget.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';

import {
  approveErc20IfNeeded,
  type Erc20ContractFactory,
} from './erc20Approve.js';
import {
  SwapsXyzClient,
  SwapsXyzRequestError,
  isEvmTx,
  isSolanaTx,
  isSwapsXyzNotFoundError,
  isSwapsXyzDeferredError,
  isSwapsXyzTerminalError,
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
const MAX_REGISTRATION_ATTEMPTS = 3;
const MAX_TRANSACTION_AGE_MS = 30_000;
const MAX_PREPARATION_ATTEMPTS = 3;
const DEFAULT_MAX_EVM_NATIVE_FEE_WEI = 10_000_000_000_000_000n;
const DEFAULT_MAX_TRON_NATIVE_FEE_SUN = 20_000_000n;
const DEFAULT_MAX_SOLANA_NATIVE_SPEND_LAMPORTS = 10_000_000;
const tokenAmountOffset = AccountLayout.offsetOf('amount');
assert(
  tokenAmountOffset !== undefined,
  'SPL token account layout is missing amount',
);
const TOKEN_AMOUNT_OFFSET = tokenAmountOffset;

export interface SwapsXyzBridgeConfig {
  apiKey: string;
  apiUrl?: string;
  defaultSlippage?: number;
  maxQuoteLossBps?: number;
  maxEvmNativeFeeWei?: bigint;
  maxTronNativeFeeSun?: bigint;
  maxSolanaNativeSpendLamports?: number;
  maxSolanaTransactionFeeLamports?: number;
  solanaTransactionFeeWarningLamports?: number;
  chainMetadata?: ChainMap<ChainMetadata>;
  evmProviderFactory?: (rpcUrl: string) => providers.Provider;
  solanaConnectionFactory?: (rpcUrl: string) => Connection;
  tronWalletFactory?: (privateKey: string, rpcUrl: string) => Wallet;
  registerTxRetryDelayMs?: number;
  erc20ContractFactory?: Erc20ContractFactory;
}

interface TokenAccountSnapshot {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegateOption: number;
  delegate: PublicKey;
  delegatedAmount: bigint;
  closeAuthorityOption: number;
  closeAuthority: PublicKey;
  state: number;
}

export interface SolanaPreparationDiagnostics {
  transactionFeeLamports: number;
  maxSolanaTransactionFeeLamports: number;
  solanaTransactionFeeWarningLamports: number;
  maxSolanaNativeSpendLamports: number;
  simulatedSignerDebitLamports: string;
  computeUnitsConsumed?: number;
  accountContextSlot: number;
  simulationContextSlot: number;
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

function isTokenProgram(programId: PublicKey): boolean {
  return (
    programId.equals(TOKEN_PROGRAM_ID) ||
    programId.equals(TOKEN_2022_PROGRAM_ID)
  );
}

function decodeTokenAccount(
  programId: PublicKey,
  data: Buffer,
): TokenAccountSnapshot | undefined {
  if (!isTokenProgram(programId) || data.length < ACCOUNT_SIZE)
    return undefined;
  const decoded = AccountLayout.decode(data.subarray(0, ACCOUNT_SIZE));
  return {
    mint: decoded.mint,
    owner: decoded.owner,
    amount: decoded.amount,
    delegateOption: decoded.delegateOption,
    delegate: decoded.delegate,
    delegatedAmount: decoded.delegatedAmount,
    closeAuthorityOption: decoded.closeAuthorityOption,
    closeAuthority: decoded.closeAuthority,
    state: decoded.state,
  };
}

function simulatedAccountData(
  account: SimulatedTransactionAccountInfo,
): Buffer {
  assert(
    account.data[1] === 'base64',
    'SwapsXyzBridge.execute Solana simulation account must use base64 encoding',
  );
  return Buffer.from(account.data[0], 'base64');
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
  private readonly maxSolanaNativeSpendLamports: number;
  private readonly maxSolanaTransactionFeeLamports: number;
  private readonly solanaTransactionFeeWarningLamports: number;
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
    const maxSolanaNativeSpendLamports =
      config.maxSolanaNativeSpendLamports ??
      DEFAULT_MAX_SOLANA_NATIVE_SPEND_LAMPORTS;
    assert(
      Number.isSafeInteger(maxSolanaNativeSpendLamports) &&
        maxSolanaNativeSpendLamports >= 0,
      'maxSolanaNativeSpendLamports must be a non-negative safe integer',
    );
    this.maxSolanaTransactionFeeLamports =
      config.maxSolanaTransactionFeeLamports ??
      DEFAULT_MAX_SOLANA_TRANSACTION_FEE_LAMPORTS;
    this.solanaTransactionFeeWarningLamports =
      config.solanaTransactionFeeWarningLamports ??
      DEFAULT_SOLANA_TRANSACTION_FEE_WARNING_LAMPORTS;
    assert(
      Number.isSafeInteger(this.maxSolanaTransactionFeeLamports) &&
        this.maxSolanaTransactionFeeLamports >= 0,
      'maxSolanaTransactionFeeLamports must be a non-negative safe integer',
    );
    assert(
      Number.isSafeInteger(this.solanaTransactionFeeWarningLamports) &&
        this.solanaTransactionFeeWarningLamports >= 0 &&
        this.solanaTransactionFeeWarningLamports <=
          this.maxSolanaTransactionFeeLamports,
      'solanaTransactionFeeWarningLamports must be a non-negative safe integer at most maxSolanaTransactionFeeLamports',
    );
    this.logger = logger;
    this.getSlippageBps(); // Validate the bridge-level default at construction.
    this.client =
      client ??
      new SwapsXyzClient(
        {
          apiKey: config.apiKey,
          apiUrl: config.apiUrl,
        },
        logger,
      );
    this.evmProviderFactory =
      config.evmProviderFactory ??
      ((rpcUrl) => new providers.StaticJsonRpcProvider(rpcUrl));
    this.solanaConnectionFactory =
      config.solanaConnectionFactory ??
      ((rpcUrl) => new Connection(rpcUrl, 'confirmed'));
    this.maxSolanaNativeSpendLamports = maxSolanaNativeSpendLamports;
    this.tronWalletFactory =
      config.tronWalletFactory ??
      ((privateKey, rpcUrl) => new TronWallet(privateKey, rpcUrl));
    this.registerTxRetryDelayMs =
      config.registerTxRetryDelayMs ?? REGISTER_TX_RETRY_DELAY_MS;

    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
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
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    const execution = this._executeLock.then(() =>
      new TransactionSubmission(options).run((observers) =>
        this.executeUnlocked(quote, privateKeys, { ...options, ...observers }),
      ),
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
      (response?.status.toLowerCase() === 'not yet created' ||
        isSwapsXyzNotFoundError(statusError)) &&
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
        {
          txHash,
          transferId,
          error:
            statusError instanceof Error ? statusError.message : statusError,
        },
        'Failed to get swaps.xyz status',
      );
      throw statusError instanceof Error
        ? statusError
        : new Error('Failed to get swaps.xyz status');
    }
    return this.toBridgeTransferStatus(
      response,
      txHash,
      fromChain,
      toChain,
      transferId,
    );
  }

  private toBridgeTransferStatus(
    response: SwapsXyzStatusResponse,
    txHash: string,
    fromChain: number,
    toChain: number,
    transferId?: string,
  ): BridgeTransferStatus {
    const protocol = this.chainMetadataByChainId.get(fromChain)?.protocol;
    const normalizeHash = (hash: string) =>
      protocol !== undefined && isEVMLike(protocol)
        ? hash.replace(/^0x/i, '').toLowerCase()
        : hash;
    if (
      (transferId !== undefined && response.txId !== transferId) ||
      (response.srcTxHash != null &&
        normalizeHash(response.srcTxHash) !== normalizeHash(txHash))
    ) {
      this.logger.warn(
        {
          txHash,
          transferId,
          responseTransferId: response.txId,
          responseSourceHash: response.srcTxHash,
        },
        'swaps.xyz status transfer identity mismatch',
      );
      return { status: 'not_found' };
    }
    // The API's chainId param is advisory: a hash registered on a different
    // chain is still returned. Such an entry is not our transfer.
    if (response.srcChainId !== null && response.srcChainId !== fromChain) {
      this.logger.warn(
        { txHash, fromChain, responseSrcChainId: response.srcChainId },
        'swaps.xyz status srcChainId does not match requested chain',
      );
      return { status: 'not_found' };
    }
    if (response.dstChainId !== null && response.dstChainId !== toChain) {
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
        if (
          response.srcChainId === null ||
          response.dstChainId === null ||
          (transferId === undefined && !response.srcTxHash) ||
          !response.dstTxHash
        ) {
          this.logger.warn(
            {
              txHash,
              responseSrcChainId: response.srcChainId,
              responseDstChainId: response.dstChainId,
            },
            'swaps.xyz completed status is missing route identity',
          );
          return { status: 'pending', substatus: rawStatus };
        }
        assert(
          response.actionResponse,
          'Completed swaps.xyz status is missing actionResponse',
        );
        return {
          status: 'complete',
          receivingTxHash: response.dstTxHash,
          receivedAmount: BigInt(response.actionResponse.amountOut.amount),
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
    for (const [chainId, token] of [
      [params.fromChain, params.fromToken],
      [params.toChain, params.toToken],
    ] as const) {
      assert(
        this.chainMetadataByChainId.get(chainId)?.protocol !==
          ProtocolType.Sealevel || token !== NATIVE_TOKEN_ADDRESS,
        'swaps.xyz native SOL is not supported; use an SPL token',
      );
    }
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
    const fraction =
      slippage ?? this.config.defaultSlippage ?? DEFAULT_SLIPPAGE;
    assert(
      Number.isFinite(fraction) && fraction >= 0 && fraction <= 1,
      'swaps.xyz slippage must be between 0 and 1',
    );
    return Math.round(fraction * 10_000);
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
        const quote = await this.toBridgeQuote(forwardParams, response);
        // This executable request is exact input, but retains the original target.
        return {
          ...quote,
          toAmountMin:
            quote.toAmountMin > toAmount ? quote.toAmountMin : toAmount,
        };
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
      const decimals = metadata.nativeToken?.decimals;
      assert(
        decimals !== undefined,
        `Missing native token decimals for ${metadata.name}`,
      );
      return decimals;
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
    const provider =
      metadata.protocol === ProtocolType.Tron
        ? new TronJsonRpcProvider(rpcUrl)
        : this.evmProviderFactory(rpcUrl);
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
    await this.validateQuoteLoss(
      params,
      response,
      fromAmount,
      BigInt(response.amountOut.amount),
    );

    return {
      id: response.txId,
      tool: response.bridgeIds?.join('+') || 'swapsxyz',
      fromAmount,
      toAmount: BigInt(response.amountOut.amount),
      toAmountMin: await this.executionMinimum(params, response),
      executionDuration: response.estimatedTxTime ?? 0,
      gasCosts: 0n,
      feeCosts,
      route: { actionResponse: response },
      requestParams: params,
    };
  }

  private async executionMinimum(
    params: BridgeQuoteParams,
    response: SwapsXyzActionResponse,
  ): Promise<bigint> {
    let expectedFloor: bigint;
    if (params.toAmount !== undefined) {
      expectedFloor = params.toAmount;
    } else {
      const maxLoss = this.config.maxQuoteLossBps;
      // No economic drift budget was configured for this exact-input request.
      if (maxLoss === undefined) return BigInt(response.amountOutMin.amount);
      assert(params.fromAmount !== undefined, 'Missing exact-input amount');
      const [sourceDecimals, destinationDecimals] = await Promise.all([
        this.getTokenDecimals(params.fromChain, params.fromToken),
        this.getTokenDecimals(params.toChain, params.toToken),
      ]);
      expectedFloor = minimumOutputForLoss(
        params.fromAmount,
        sourceDecimals,
        destinationDecimals,
        maxLoss,
      );
    }
    const minimum =
      (expectedFloor *
        (BPS_DENOMINATOR - BigInt(this.getSlippageBps(params.slippage)))) /
      BPS_DENOMINATOR;
    return minimum > 0n ? minimum : 1n;
  }

  private async executeUnlocked(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    this.validateQuoteParams(quote.requestParams);
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
      return this.executeSolana(quote, privateKeys, rpcUrl, options);
    }
    if (metadata.protocol === ProtocolType.Tron) {
      return this.executeTron(quote, privateKeys, rpcUrl, options);
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

    for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt++) {
      const { response: fresh, preparedAt } = await this.prepare(quote);
      assert(isEvmTx(fresh.tx), 'SwapsXyzBridge.execute requires an EVM tx');
      if (fresh.requiresTokenApproval) {
        await approveErc20IfNeeded(
          signer,
          quote.requestParams.fromToken,
          fresh.tx.to,
          BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
          this.logger,
          {
            contractFactory: this.config.erc20ContractFactory,
            onApproval: options?.onApproval,
          },
        );
      }

      if (Date.now() - preparedAt >= MAX_TRANSACTION_AGE_MS) continue;
      await this.validatePreparedEvmOrder(quote, fresh);
      if (Date.now() - preparedAt >= MAX_TRANSACTION_AGE_MS) continue;
      const transaction = {
        to: fresh.tx.to,
        data: fresh.tx.data,
        value: fresh.tx.value ? BigNumber.from(fresh.tx.value) : undefined,
      };
      await signer.estimateGas(transaction);
      await options?.onTransferId?.(fresh.txId);
      const txResponse = await submitEvmLikeTransaction(
        signer,
        transaction,
        options,
      );
      // Source-action tracking takes priority over waiting here: once a
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
    throw new Error(
      'swaps.xyz transaction expired repeatedly during preparation',
    );
  }

  /** Validate a fresh unsigned payload without keys, approvals or signing. */
  async prepare(quote: BridgeQuote): Promise<{
    response: SwapsXyzActionResponse;
    preparedAt: number;
    solanaDiagnostics?: SolanaPreparationDiagnostics;
  }> {
    this.validateQuoteParams(quote.requestParams);
    const metadata = this.chainMetadataByChainId.get(
      quote.requestParams.fromChain,
    );
    if (metadata?.protocol === ProtocolType.Sealevel) {
      const rpcUrl = metadata.rpcUrls[0]?.http;
      assert(rpcUrl, 'Missing Solana RPC for unsigned preparation');
      return this.prepareSolana(quote, rpcUrl);
    }
    let preparedAt = Date.now();
    const response = await this.client.getAction(
      this.buildActionRequest(quote.requestParams),
      (startedAt) => {
        preparedAt = startedAt;
      },
    );
    if (metadata?.protocol === ProtocolType.Tron)
      this.validatePreparedTronOrder(quote, response);
    else await this.validatePreparedEvmOrder(quote, response);
    await this.validateQuoteLoss(
      quote.requestParams,
      response,
      BigInt((response.amountInMax ?? response.amountIn).amount),
      BigInt(response.amountOut.amount),
    );
    assert(
      Date.now() - preparedAt < MAX_TRANSACTION_AGE_MS,
      'swaps.xyz transaction expired during preparation',
    );
    return { response, preparedAt };
  }

  private async validatePreparedEvmOrder(
    quote: BridgeQuote,
    fresh: SwapsXyzActionResponse,
  ): Promise<void> {
    assert(isEvmTx(fresh.tx), 'SwapsXyzBridge.execute requires an EVM tx');
    this.validateActionResponse(fresh, quote, 'evm');
  }

  private async executeSolana(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    rpcUrl: string,
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    const { fromChain, toChain } = quote.requestParams;
    const rawKey = privateKeys[ProtocolType.Sealevel];
    assert(
      rawKey,
      'SwapsXyzBridge.execute requires a Sealevel private key for Solana-source routes',
    );
    const keypair = Keypair.fromSecretKey(parseSolanaPrivateKey(rawKey));
    assert(
      keypair.publicKey.toBase58() === quote.requestParams.fromAddress,
      'SwapsXyzBridge.execute Solana signer does not match quote fromAddress',
    );

    const { response: fresh, transaction } = await this.prepareSolana(
      quote,
      rpcUrl,
    );
    const connection = this.solanaConnectionFactory(rpcUrl);
    await options?.onTransferId?.(fresh.txId);
    transaction.sign([keypair]);
    const signedSignature = bufferToBase58(
      Buffer.from(transaction.signatures[0]),
    );
    const signature = await new TransactionSubmission(options).submit(
      () =>
        connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 5,
        }),
      (submittedSignature) => {
        assert(
          submittedSignature === signedSignature,
          'swaps.xyz RPC returned a different Solana signature',
        );
        return signedSignature;
      },
      signedSignature,
    );
    void this.registerIfRequired(fresh, signature);
    return {
      txHash: signature,
      fromChain,
      toChain,
      transferId: fresh.txId,
    };
  }

  private async prepareSolana(
    quote: BridgeQuote,
    rpcUrl: string,
  ): Promise<{
    response: SwapsXyzActionResponse;
    preparedAt: number;
    transaction: VersionedTransaction;
    solanaDiagnostics: SolanaPreparationDiagnostics;
  }> {
    let preparedAt = Date.now();
    const signer = new PublicKey(quote.requestParams.fromAddress);
    const fresh = await this.client.getAction(
      this.buildActionRequest(quote.requestParams),
      (startedAt) => {
        preparedAt = startedAt;
      },
    );
    assert(isSolanaTx(fresh.tx), 'SwapsXyzBridge.execute requires a Solana tx');
    this.validateSolanaActionResponse(fresh, quote);
    await this.validateQuoteLoss(
      quote.requestParams,
      fresh,
      BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
      BigInt(fresh.amountOut.amount),
    );

    const transaction = VersionedTransaction.deserialize(
      Buffer.from(fresh.tx.base64Tx, 'base64'),
    );
    assert(
      transaction.message.header.numRequiredSignatures === 1,
      'SwapsXyzBridge.execute Solana transaction must require exactly one signer',
    );
    assert(
      transaction.message.staticAccountKeys[0]?.equals(signer),
      'SwapsXyzBridge.execute Solana payer does not match inventory signer',
    );
    if (fresh.tx.payer !== undefined) {
      assert(
        fresh.tx.payer === signer.toBase58(),
        `SwapsXyzBridge.execute Solana payer ${fresh.tx.payer} does not match signer ${signer.toBase58()}`,
      );
    }

    const connection = this.solanaConnectionFactory(rpcUrl);
    const addressLookupTables = await this.resolveAddressLookupTables(
      connection,
      transaction,
    );
    const accountKeys = transaction.message.getAccountKeys({
      addressLookupTableAccounts: addressLookupTables,
    });
    const writableKeys = accountKeys
      .keySegments()
      .flat()
      .filter((_, index) => transaction.message.isAccountWritable(index));
    assert(
      writableKeys.some((key) => key.equals(signer)),
      'SwapsXyzBridge.execute Solana payer must be writable',
    );

    const preAccounts = await connection.getMultipleAccountsInfoAndContext(
      writableKeys,
      { commitment: 'confirmed' },
    );
    assert(
      preAccounts.value.length === writableKeys.length,
      'SwapsXyzBridge.execute Solana preflight did not return every writable account',
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.message.recentBlockhash = blockhash;
    const fee = await connection.getFeeForMessage(
      transaction.message,
      'confirmed',
    );
    assert(
      fee.value !== null,
      'SwapsXyzBridge.execute could not calculate the Solana transaction fee',
    );
    assert(
      Number.isSafeInteger(fee.value) && fee.value >= 0,
      'SwapsXyzBridge.execute Solana transaction fee must be a non-negative safe integer',
    );
    const feeDiagnostics = {
      chainId: quote.requestParams.fromChain,
      transactionFeeLamports: fee.value,
      maxSolanaTransactionFeeLamports: this.maxSolanaTransactionFeeLamports,
      solanaTransactionFeeWarningLamports:
        this.solanaTransactionFeeWarningLamports,
    };
    if (fee.value > this.solanaTransactionFeeWarningLamports) {
      this.logger.warn(
        feeDiagnostics,
        'SwapsXyz Solana transaction fee exceeds warning threshold',
      );
    } else {
      this.logger.info(feeDiagnostics, 'SwapsXyz Solana transaction fee');
    }
    assert(
      fee.value <= this.maxSolanaTransactionFeeLamports,
      `SwapsXyzBridge.execute Solana transaction fee ${fee.value} exceeds maximum ${this.maxSolanaTransactionFeeLamports}`,
    );
    const simulation = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      commitment: 'confirmed',
      minContextSlot: preAccounts.context.slot,
      accounts: {
        encoding: 'base64',
        addresses: writableKeys.map((key) => key.toBase58()),
      },
    });
    assert(
      simulation.value.err === null,
      `SwapsXyzBridge.execute Solana simulation failed: ${JSON.stringify(simulation.value.err)}`,
    );
    assert(
      simulation.value.accounts?.length === writableKeys.length,
      'SwapsXyzBridge.execute Solana simulation did not return every writable account',
    );

    const signerDebit = this.validateSolanaAccountEffects(
      quote,
      fresh,
      signer,
      writableKeys,
      preAccounts.value,
      simulation.value.accounts,
      fee.value,
    );
    assert(
      Date.now() - preparedAt < MAX_TRANSACTION_AGE_MS,
      'swaps.xyz transaction expired during preparation',
    );
    return {
      response: fresh,
      preparedAt,
      transaction,
      solanaDiagnostics: {
        transactionFeeLamports: fee.value,
        maxSolanaTransactionFeeLamports: this.maxSolanaTransactionFeeLamports,
        solanaTransactionFeeWarningLamports:
          this.solanaTransactionFeeWarningLamports,
        maxSolanaNativeSpendLamports: this.maxSolanaNativeSpendLamports,
        simulatedSignerDebitLamports: signerDebit.toString(),
        computeUnitsConsumed: simulation.value.unitsConsumed,
        accountContextSlot: preAccounts.context.slot,
        simulationContextSlot: simulation.context.slot,
      },
    };
  }

  private async executeTron(
    quote: BridgeQuote,
    privateKeys: Partial<Record<ProtocolType, string>>,
    rpcUrl: string,
    options?: BridgeExecutionOptions,
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

    for (let attempt = 0; attempt < MAX_PREPARATION_ATTEMPTS; attempt++) {
      const { response: fresh, preparedAt } = await this.prepare(quote);
      const freshTx = fresh.tx;
      assert(isTronTx(freshTx), 'SwapsXyzBridge.execute requires a Tron tx');
      const transactionTo = this.tronAddressToEvm(freshTx.to);
      const isNativeSource = this.addressesEqual(
        quote.requestParams.fromToken,
        NATIVE_TOKEN_ADDRESS,
        fromChain,
      );
      const sourceToken = isNativeSource
        ? undefined
        : this.tronAddressToEvm(quote.requestParams.fromToken);
      let transaction: providers.TransactionRequest;

      if (freshTx.toExtra === null) {
        const transferAmount = BigNumber.from(freshTx.value);
        transaction = isNativeSource
          ? { to: transactionTo, value: transferAmount }
          : {
              to: sourceToken,
              data: ERC20_TRANSFER_INTERFACE.encodeFunctionData('transfer', [
                transactionTo,
                transferAmount,
              ]),
              value: 0,
            };
      } else {
        if (fresh.requiresTokenApproval) {
          assert(sourceToken, 'Native Tron routes must not require approval');
          await approveErc20IfNeeded(
            signer,
            sourceToken,
            transactionTo,
            BigInt((fresh.amountInMax ?? fresh.amountIn).amount),
            this.logger,
            {
              contractFactory: this.config.erc20ContractFactory,
              onApproval: options?.onApproval,
            },
          );
        }
        if (Date.now() - preparedAt >= MAX_TRANSACTION_AGE_MS) continue;
        this.validatePreparedTronOrder(quote, fresh);
        transaction = {
          to: transactionTo,
          data: ensure0x(freshTx.toExtra),
          value: BigNumber.from(freshTx.value),
        };
      }

      await signer.estimateGas(transaction);
      await options?.onTransferId?.(fresh.txId);
      const txResponse = await submitEvmLikeTransaction(
        signer,
        transaction,
        options,
      );
      const txHash = ensure0x(txResponse.hash);
      void this.registerIfRequired(fresh, txHash);
      return {
        txHash,
        fromChain,
        toChain,
        transferId: fresh.txId,
      };
    }
    throw new Error(
      'swaps.xyz transaction expired repeatedly during preparation',
    );
  }

  private async resolveAddressLookupTables(
    connection: Connection,
    transaction: VersionedTransaction,
  ): Promise<AddressLookupTableAccount[]> {
    return Promise.all(
      transaction.message.addressTableLookups.map(async (lookup) => {
        const { value } = await connection.getAddressLookupTable(
          lookup.accountKey,
          { commitment: 'confirmed' },
        );
        assert(
          value,
          `SwapsXyzBridge.execute Solana address lookup table ${lookup.accountKey.toBase58()} was not found`,
        );
        return value;
      }),
    );
  }

  private validateActionResponseMetadata(
    response: SwapsXyzActionResponse,
    quote: BridgeQuote,
    expectedVmId: 'evm' | 'solana' | 'alt-vm',
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
  }

  private validateActionResponse(
    response: SwapsXyzActionResponse,
    quote: BridgeQuote,
    expectedVmId: 'evm',
  ): void {
    this.validateActionResponseMetadata(response, quote, expectedVmId);
    const params = quote.requestParams;
    const tx = response.tx;
    assert(isEvmTx(tx), 'SwapsXyzBridge.execute EVM transaction is invalid');
    assert(
      utils.isAddress(tx.to),
      `SwapsXyzBridge.execute transaction target ${tx.to} is invalid`,
    );
    assert(
      /^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data),
      'SwapsXyzBridge.execute transaction calldata is invalid',
    );
    const freshFromAmount = BigInt(
      (response.amountInMax ?? response.amountIn).amount,
    );
    const freshValue = transactionValue(
      response.tx,
      'SwapsXyzBridge.execute fresh',
    );
    const nativePrincipal = this.addressesEqual(
      params.fromToken,
      NATIVE_TOKEN_ADDRESS,
      params.fromChain,
    )
      ? freshFromAmount
      : 0n;
    const minimumNativePrincipal = this.addressesEqual(
      params.fromToken,
      NATIVE_TOKEN_ADDRESS,
      params.fromChain,
    )
      ? BigInt(response.amountIn.amount)
      : 0n;
    assert(
      freshValue >= minimumNativePrincipal,
      'SwapsXyzBridge.execute transaction value is below the native token input',
    );
    const nativeFee =
      freshValue > nativePrincipal ? freshValue - nativePrincipal : 0n;
    const maxNativeFee =
      this.config.maxEvmNativeFeeWei ?? DEFAULT_MAX_EVM_NATIVE_FEE_WEI;
    assert(
      nativeFee <= maxNativeFee,
      `SwapsXyzBridge.execute native fee ${nativeFee} exceeds configured maximum ${maxNativeFee}`,
    );
  }

  private validatePreparedTronOrder(
    quote: BridgeQuote,
    response: SwapsXyzActionResponse,
  ): void {
    this.validateActionResponseMetadata(response, quote, 'alt-vm');
    const tx = response.tx;
    assert(isTronTx(tx), 'SwapsXyzBridge.execute requires a Tron tx');
    const target = this.tronAddressToEvm(tx.to);
    const isNativeSource = this.addressesEqual(
      quote.requestParams.fromToken,
      NATIVE_TOKEN_ADDRESS,
      quote.requestParams.fromChain,
    );
    const sourceToken = isNativeSource
      ? undefined
      : this.tronAddressToEvm(quote.requestParams.fromToken);
    const freshFromAmount = BigInt(
      (response.amountInMax ?? response.amountIn).amount,
    );

    if (tx.toExtra === null) {
      assert(
        response.requiresTokenApproval === false,
        'SwapsXyzBridge.execute direct Tron transfers must not require token approval',
      );
      assert(
        sourceToken === undefined ||
          target.toLowerCase() !== sourceToken.toLowerCase(),
        'SwapsXyzBridge.execute rejects direct Tron deposits to the source token',
      );
      const transferAmount = BigInt(tx.value);
      assert(
        transferAmount >= BigInt(response.amountIn.amount) &&
          transferAmount <= freshFromAmount,
        `SwapsXyzBridge.execute Tron transfer amount ${transferAmount} is outside fresh input bounds`,
      );
      return;
    }

    assert(
      /^0x(?:[0-9a-fA-F]{2})*$/.test(ensure0x(tx.toExtra)),
      'SwapsXyzBridge.execute Tron calldata is invalid',
    );
    const nativeValue = BigInt(tx.value);
    const nativePrincipal = isNativeSource ? freshFromAmount : 0n;
    assert(
      nativeValue >= (isNativeSource ? BigInt(response.amountIn.amount) : 0n),
      'SwapsXyzBridge.execute Tron transaction value is below the native token input',
    );
    const nativeFee =
      nativeValue > nativePrincipal ? nativeValue - nativePrincipal : 0n;
    const maxNativeFee =
      this.config.maxTronNativeFeeSun ?? DEFAULT_MAX_TRON_NATIVE_FEE_SUN;
    assert(
      nativeFee <= maxNativeFee,
      `SwapsXyzBridge.execute Tron native fee ${nativeFee} exceeds configured maximum ${maxNativeFee}`,
    );
  }

  private validateSolanaActionResponse(
    response: SwapsXyzActionResponse,
    quote: BridgeQuote,
  ): void {
    this.validateActionResponseMetadata(response, quote, 'solana');
    assert(
      isSolanaTx(response.tx),
      'SwapsXyzBridge.execute Solana transaction is invalid',
    );
  }

  private validateSolanaAccountEffects(
    quote: BridgeQuote,
    response: SwapsXyzActionResponse,
    signer: PublicKey,
    writableKeys: PublicKey[],
    preAccounts: Array<AccountInfo<Buffer> | null>,
    postAccounts: Array<SimulatedTransactionAccountInfo | null>,
    transactionFeeLamports: number,
  ): bigint {
    const sourceMint = new PublicKey(quote.requestParams.fromToken);
    let sourceDebit = 0n;
    let signerLamportDebit: bigint | undefined;

    for (let index = 0; index < writableKeys.length; index++) {
      const address = writableKeys[index];
      const pre = preAccounts[index];
      const post = postAccounts[index];

      if (address.equals(signer)) {
        assert(pre && post, 'Solana signer account is missing from simulation');
        assert(
          post.owner === pre.owner.toBase58() &&
            post.executable === pre.executable &&
            simulatedAccountData(post).equals(pre.data),
          'SwapsXyzBridge.execute Solana transaction changes signer account ownership or data',
        );
        signerLamportDebit =
          pre.lamports > post.lamports
            ? BigInt(pre.lamports - post.lamports)
            : 0n;
      }

      if (!pre) continue;
      const preToken = decodeTokenAccount(pre.owner, pre.data);
      if (!preToken?.owner.equals(signer)) continue;
      assert(
        post,
        `SwapsXyzBridge.execute Solana transaction closes signer token account ${address.toBase58()}`,
      );
      const postData = simulatedAccountData(post);
      const postToken = decodeTokenAccount(new PublicKey(post.owner), postData);
      assert(
        postToken,
        `SwapsXyzBridge.execute Solana transaction changes signer token account ${address.toBase58()} into a non-token account`,
      );
      assert(
        postToken.mint.equals(preToken.mint) &&
          postToken.owner.equals(preToken.owner) &&
          postToken.delegateOption === preToken.delegateOption &&
          postToken.delegate.equals(preToken.delegate) &&
          postToken.delegatedAmount === preToken.delegatedAmount &&
          postToken.closeAuthorityOption === preToken.closeAuthorityOption &&
          postToken.closeAuthority.equals(preToken.closeAuthority) &&
          postToken.state === preToken.state,
        `SwapsXyzBridge.execute Solana transaction changes authority or state for signer token account ${address.toBase58()}`,
      );
      assert(
        postData.length === pre.data.length,
        `SwapsXyzBridge.execute Solana transaction changes data length for signer token account ${address.toBase58()}`,
      );
      const normalizedPostData = Buffer.from(postData);
      pre.data.copy(
        normalizedPostData,
        TOKEN_AMOUNT_OFFSET,
        TOKEN_AMOUNT_OFFSET,
        TOKEN_AMOUNT_OFFSET + 8,
      );
      assert(
        normalizedPostData.equals(pre.data),
        `SwapsXyzBridge.execute Solana transaction changes non-balance data for signer token account ${address.toBase58()}`,
      );

      const debit =
        preToken.amount > postToken.amount
          ? preToken.amount - postToken.amount
          : 0n;
      if (preToken.mint.equals(sourceMint)) {
        sourceDebit += debit;
      } else {
        assert(
          debit === 0n,
          `SwapsXyzBridge.execute Solana transaction debits non-source token account ${address.toBase58()}`,
        );
      }
    }

    assert(
      signerLamportDebit !== undefined,
      'SwapsXyzBridge.execute Solana simulation omitted the signer account',
    );
    const maxLamportDebit =
      BigInt(transactionFeeLamports) +
      BigInt(this.maxSolanaNativeSpendLamports);
    assert(
      signerLamportDebit <= maxLamportDebit,
      `SwapsXyzBridge.execute Solana native spend ${signerLamportDebit} exceeds maximum ${maxLamportDebit}`,
    );

    if (quote.requestParams.fromAmount !== undefined) {
      const expectedDebit = quote.requestParams.fromAmount;
      assert(
        sourceDebit === expectedDebit,
        `SwapsXyzBridge.execute Solana source-token debit ${sourceDebit} does not match exact input ${expectedDebit}`,
      );
    } else {
      const maxDebit = BigInt(
        (response.amountInMax ?? response.amountIn).amount,
      );
      assert(
        sourceDebit > 0n && sourceDebit <= maxDebit,
        `SwapsXyzBridge.execute Solana source-token debit ${sourceDebit} exceeds exact-output cap ${maxDebit}`,
      );
    }
    return signerLamportDebit;
  }

  private async validateQuoteLoss(
    params: BridgeQuoteParams,
    response: SwapsXyzActionResponse,
    fromAmount: bigint,
    toAmount: bigint,
  ): Promise<void> {
    const amountIn = BigInt(response.amountIn.amount);
    const maximumInput = BigInt(
      (response.amountInMax ?? response.amountIn).amount,
    );
    const minimumOutput = BigInt(response.amountOutMin.amount);
    const expectedOutput = BigInt(response.amountOut.amount);
    assert(
      amountIn > 0n && maximumInput >= amountIn,
      'swaps.xyz invalid input amount bounds',
    );
    if (params.fromAmount !== undefined) {
      assert(
        amountIn === params.fromAmount && maximumInput === params.fromAmount,
        'swaps.xyz exact input does not match the requested amount',
      );
    }
    if (params.toAmount !== undefined) {
      assert(
        expectedOutput >= params.toAmount,
        'swaps.xyz expected output is below the requested amount',
      );
    }
    const slippageFloor =
      (expectedOutput *
        (BPS_DENOMINATOR - BigInt(this.getSlippageBps(params.slippage)))) /
      BPS_DENOMINATOR;
    assert(
      minimumOutput > 0n &&
        minimumOutput <= expectedOutput &&
        minimumOutput >= slippageFloor,
      'swaps.xyz minimum output exceeds the requested slippage',
    );
    const maxQuoteLossBps = this.config.maxQuoteLossBps;
    if (maxQuoteLossBps === undefined) return;

    const [sourceDecimals, destinationDecimals] = await Promise.all([
      this.getTokenDecimals(params.fromChain, params.fromToken),
      this.getTokenDecimals(params.toChain, params.toToken),
    ]);
    assert(
      sourceDecimals <= 255 && destinationDecimals <= 255,
      'swaps.xyz quote token decimals must be at most 255',
    );
    for (const amount of [response.amountIn, response.amountInMax]) {
      assert(
        amount?.decimals === undefined || amount.decimals === sourceDecimals,
        'swaps.xyz source token decimals do not match chain data',
      );
    }
    for (const amount of [response.amountOut, response.amountOutMin]) {
      assert(
        amount.decimals === undefined ||
          amount.decimals === destinationDecimals,
        'swaps.xyz destination token decimals do not match chain data',
      );
    }
    const commonDecimals = Math.max(sourceDecimals, destinationDecimals);
    const normalizedFromAmount =
      fromAmount * 10n ** BigInt(commonDecimals - sourceDecimals);
    const normalizedToAmount =
      toAmount * 10n ** BigInt(commonDecimals - destinationDecimals);
    const lossBps =
      normalizedToAmount >= normalizedFromAmount
        ? 0n
        : ceilDiv(
            (normalizedFromAmount - normalizedToAmount) * BPS_DENOMINATOR,
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
    for (let attempt = 0; ; attempt++) {
      try {
        const results = await this.client.registerTxs([{ txId, txHash }]);
        const failed = results.find((result) => !result.success);
        if (failed) {
          throw new Error(
            `swaps.xyz registerTxs failed: ${failed.error ?? 'unknown error'}`,
          );
        }
        return true;
      } catch (error) {
        if (
          isSwapsXyzTerminalError(error) ||
          isSwapsXyzDeferredError(error) ||
          attempt >= MAX_REGISTRATION_ATTEMPTS - 1
        ) {
          this.logger.error(
            { txId, txHash, error },
            'Failed to register swaps.xyz transaction',
          );
          return false;
        }
        await sleep(this.registerTxRetryDelayMs * 2 ** attempt);
      }
    }
  }
}
