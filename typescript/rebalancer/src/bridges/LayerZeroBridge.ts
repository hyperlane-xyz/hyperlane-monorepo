import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { z } from 'zod';

import { TokenBridgeOft__factory } from '@hyperlane-xyz/core';
import {
  type ChainMap,
  type ChainMetadata,
  type WarpCoreConfig,
  submitEvmLikeTransaction,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytesTron, assert } from '@hyperlane-xyz/utils';
import {
  TronJsonRpcProvider,
  TronWallet,
} from '@hyperlane-xyz/tron-sdk/runtime';

import type {
  BridgeExecutionOptions,
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import { approveErc20IfNeeded } from './erc20Approve.js';

const LAYERZERO_TOOL = 'layerzero';
const LAYERZERO_SCAN_API_URL = 'https://scan.layerzero-api.com/v1/messages/tx/';
const MAX_QUOTE_ATTEMPTS = 8;
const BASIS_POINTS_DENOMINATOR = 10_000n;
const DEFAULT_MAX_FEE_BPS = 50;
const DEFAULT_MAX_EVM_NATIVE_VALUE_WEI = 10_000_000_000_000_000n;
const DEFAULT_MAX_TRON_NATIVE_VALUE_SUN = 20_000_000n;

const ScanStatusSchema = z.union([
  z.string(),
  z.object({ name: z.string() }).passthrough(),
]);
const ScanMessageSchema = z
  .object({
    pathway: z
      .object({ srcEid: z.number(), dstEid: z.number() })
      .passthrough()
      .optional(),
    status: ScanStatusSchema,
    destination: z
      .object({
        status: z.string().optional(),
        tx: z.object({ txHash: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
    dstTxHash: z.string().optional(),
  })
  .passthrough();
const ScanResponseSchema = z
  .object({
    data: z.array(ScanMessageSchema).optional(),
    messages: z.array(ScanMessageSchema).optional(),
  })
  .passthrough();

type RouteToken = WarpCoreConfig['tokens'][number];

interface ConfiguredWarpRoute {
  id: string;
  config: WarpCoreConfig;
}

interface ResolvedRoute {
  warpRouteId: string;
  source: RouteToken;
  destination: RouteToken;
  sourceMetadata: ChainMetadata;
  destinationMetadata: ChainMetadata;
}

interface LayerZeroQuoteRoute {
  warpRouteId: string;
  sourceAdapter: string;
  destinationAdapter: string;
  destinationDomain: number;
  recipient: string;
  amount: bigint;
  nativeFee: bigint;
}

interface OftQuote {
  route: ResolvedRoute;
  recipient: string;
  amount: bigint;
  grossAmount: bigint;
  nativeFee: bigint;
  token: string;
}

export interface TokenBridgeOftContract {
  token(): Promise<string>;
  quoteTransferRemote(
    destination: number,
    recipient: string,
    amount: bigint,
  ): Promise<Array<{ token: string; amount: ethers.BigNumber }>>;
  hyperlaneDomainToLzEid(domain: number): Promise<number>;
  populateTransaction: {
    transferRemote(
      destination: number,
      recipient: string,
      amount: bigint,
      overrides: { value: bigint },
    ): Promise<ethers.PopulatedTransaction>;
  };
}

export interface LayerZeroBridgeConfig {
  chainMetadata: ChainMap<ChainMetadata>;
  warpRoutes: ConfiguredWarpRoute[];
  maxFeeBps?: number;
  maxEvmNativeValueWei?: bigint;
  maxTronNativeValueSun?: bigint;
  contractFactory?: (
    address: string,
    signerOrProvider: ethers.Signer | ethers.providers.Provider,
  ) => TokenBridgeOftContract;
}

export class LayerZeroBridge implements IExternalBridge {
  readonly externalBridgeId = LAYERZERO_TOOL;
  readonly logger: Logger;

  private readonly metadataByChainId = new Map<number, ChainMetadata>();
  private readonly metadataByName = new Map<string, ChainMetadata>();
  private readonly maxFeeBps: number;
  private readonly maxEvmNativeValueWei: bigint;
  private readonly maxTronNativeValueSun: bigint;
  private readonly expectedReceivedByTxHash = new Map<string, bigint>();

  constructor(
    private readonly config: LayerZeroBridgeConfig,
    logger: Logger,
  ) {
    this.logger = logger;
    assert(
      config.warpRoutes.length > 0,
      'At least one OFT warp route is required',
    );
    this.maxFeeBps = config.maxFeeBps ?? DEFAULT_MAX_FEE_BPS;
    assert(
      Number.isInteger(this.maxFeeBps) &&
        this.maxFeeBps >= 0 &&
        this.maxFeeBps <= Number(BASIS_POINTS_DENOMINATOR),
      'maxFeeBps must be an integer between 0 and 10000',
    );
    this.maxEvmNativeValueWei =
      config.maxEvmNativeValueWei ?? DEFAULT_MAX_EVM_NATIVE_VALUE_WEI;
    this.maxTronNativeValueSun =
      config.maxTronNativeValueSun ?? DEFAULT_MAX_TRON_NATIVE_VALUE_SUN;

    for (const metadata of Object.values(config.chainMetadata)) {
      if (metadata.chainId === undefined) continue;
      const chainId = Number(metadata.chainId);
      assert(
        Number.isSafeInteger(chainId),
        `Invalid chain ID for ${metadata.name}`,
      );
      this.metadataByChainId.set(chainId, metadata);
      this.metadataByName.set(metadata.name, metadata);
    }
  }

  async quote(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<LayerZeroQuoteRoute>> {
    this.validateQuoteParams(params);
    const targetAmount = params.toAmount ?? params.fromAmount;
    assert(targetAmount !== undefined, 'Missing OFT transfer amount');

    let quoted = await this.quoteDestinationAmount(params, targetAmount);
    if (params.fromAmount !== undefined) {
      for (
        let attempt = 0;
        quoted.grossAmount > params.fromAmount && attempt < MAX_QUOTE_ATTEMPTS;
        attempt++
      ) {
        const excess: bigint = quoted.grossAmount - params.fromAmount;
        assert(
          quoted.amount > excess,
          'OFT fee consumes the entire source amount',
        );
        quoted = await this.quoteDestinationAmount(
          params,
          quoted.amount - excess,
        );
      }
      assert(
        quoted.grossAmount <= params.fromAmount,
        'Unable to derive an OFT transfer within the source amount',
      );
    }

    return this.toBridgeQuote(params, quoted);
  }

  async execute(
    quote: BridgeQuote<LayerZeroQuoteRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    assert(quote.tool === LAYERZERO_TOOL, 'Quote was not created by LayerZero');
    const params = quote.requestParams;
    const route = this.resolveRoute(
      params.fromChain,
      params.toChain,
      quote.route.warpRouteId,
    );
    const protocol = this.protocol(route.sourceMetadata);
    const privateKey = privateKeys[protocol];
    assert(privateKey, `Missing private key for ${protocol} chain`);
    const wallet = this.wallet(protocol, privateKey, route.sourceMetadata);
    const sender = await wallet.getAddress();
    assert(
      sender.toLowerCase() === params.fromAddress.toLowerCase(),
      `${protocol} private key does not match inventory signer`,
    );

    const refreshed = await this.quoteDestinationAmount(params, quote.toAmount);
    assert(
      refreshed.route.warpRouteId === quote.route.warpRouteId,
      'OFT route changed during execution',
    );
    assert(
      refreshed.grossAmount <= quote.fromAmount,
      'OFT input increased after the accepted quote',
    );
    assert(
      refreshed.nativeFee <= quote.route.nativeFee,
      'OFT native fee increased after the accepted quote',
    );

    await approveErc20IfNeeded(
      wallet,
      refreshed.token,
      route.source.addressOrDenom,
      refreshed.grossAmount,
      this.logger,
      { onApproval: options?.onApproval },
    );

    const contract = this.contract(route.source.addressOrDenom, wallet);
    const request = await contract.populateTransaction.transferRemote(
      Number(route.destinationMetadata.domainId),
      refreshed.recipient,
      refreshed.amount,
      { value: refreshed.nativeFee },
    );
    await wallet.estimateGas(request);
    await options?.onTransferId?.(route.warpRouteId);
    const response = await submitEvmLikeTransaction(wallet, request, options);
    this.expectedReceivedByTxHash.set(
      this.normalizeHash(response.hash),
      refreshed.amount,
    );

    return {
      txHash: response.hash,
      fromChain: params.fromChain,
      toChain: params.toChain,
      transferId: route.warpRouteId,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
    transferId?: string,
  ): Promise<BridgeTransferStatus> {
    const route = this.resolveRoute(fromChain, toChain, transferId);
    const response = await fetch(
      `${LAYERZERO_SCAN_API_URL}${this.normalizeHash(txHash)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (response.status === 404) return { status: 'not_found' };
    assert(response.ok, `LayerZero Scan returned HTTP ${response.status}`);
    const body = ScanResponseSchema.parse(await response.json());
    const messages = body.data ?? body.messages ?? [];

    const [sourceEid, destinationEid] = await Promise.all([
      this.contract(
        route.destination.addressOrDenom,
        this.provider(route.destinationMetadata),
      ).hyperlaneDomainToLzEid(Number(route.sourceMetadata.domainId)),
      this.contract(
        route.source.addressOrDenom,
        this.provider(route.sourceMetadata),
      ).hyperlaneDomainToLzEid(Number(route.destinationMetadata.domainId)),
    ]);
    const message = messages.find(
      (candidate) =>
        candidate.pathway?.srcEid === sourceEid &&
        candidate.pathway.dstEid === destinationEid,
    );
    if (!message) return { status: 'not_found' };

    const status =
      typeof message.status === 'string' ? message.status : message.status.name;
    if (
      [
        'APPLICATION_BURNED',
        'APPLICATION_SKIPPED',
        'UNRESOLVABLE_COMMAND',
        'MALFORMED_COMMAND',
      ].includes(status)
    ) {
      return { status: 'failed', error: status };
    }
    if (status !== 'DELIVERED' || message.destination?.status !== 'SUCCEEDED') {
      return {
        status: 'pending',
        substatus: `${status}:${message.destination?.status ?? 'UNKNOWN'}`,
      };
    }
    const receivingTxHash = message.destination.tx?.txHash ?? message.dstTxHash;
    if (!receivingTxHash) {
      return { status: 'pending', substatus: 'DESTINATION_TX_HASH_UNKNOWN' };
    }

    return {
      status: 'complete',
      receivingTxHash,
      receivedAmount:
        this.expectedReceivedByTxHash.get(this.normalizeHash(txHash)) ?? 0n,
    };
  }

  private async quoteDestinationAmount(
    params: BridgeQuoteParams,
    amount: bigint,
  ): Promise<OftQuote> {
    assert(amount > 0n, 'OFT transfer amount must be positive');
    const route = this.resolveRoute(params.fromChain, params.toChain);
    const recipient = this.recipientBytes32(
      params.toAddress ?? params.fromAddress,
    );
    const sourceContract = this.contract(
      route.source.addressOrDenom,
      this.provider(route.sourceMetadata),
    );
    const destinationContract = this.contract(
      route.destination.addressOrDenom,
      this.provider(route.destinationMetadata),
    );
    const [sourceToken, destinationToken, quotes] = await Promise.all([
      sourceContract.token(),
      destinationContract.token(),
      sourceContract.quoteTransferRemote(
        Number(route.destinationMetadata.domainId),
        recipient,
        amount,
      ),
    ]);
    assert(
      sourceToken.toLowerCase() === params.fromToken.toLowerCase(),
      `OFT source token mismatch: ${sourceToken}`,
    );
    assert(
      destinationToken.toLowerCase() === params.toToken.toLowerCase(),
      `OFT destination token mismatch: ${destinationToken}`,
    );
    const nativeQuotes = quotes.filter(
      (quote) => quote.token === ethers.constants.AddressZero,
    );
    const tokenQuotes = quotes.filter(
      (quote) => quote.token.toLowerCase() === sourceToken.toLowerCase(),
    );
    assert(
      nativeQuotes.length === 1 && tokenQuotes.length === 1,
      'OFT quote must contain one native fee and one source-token amount',
    );
    const nativeFee = BigInt(nativeQuotes[0].amount.toString());
    const grossAmount = BigInt(tokenQuotes[0].amount.toString());
    assert(
      grossAmount >= amount,
      'OFT gross amount is below destination amount',
    );
    this.assertCosts(route, amount, grossAmount, nativeFee);
    return {
      route,
      recipient,
      amount,
      grossAmount,
      nativeFee,
      token: sourceToken,
    };
  }

  private toBridgeQuote(
    params: BridgeQuoteParams,
    quoted: OftQuote,
  ): BridgeQuote<LayerZeroQuoteRoute> {
    return {
      id: crypto.randomUUID(),
      tool: LAYERZERO_TOOL,
      fromAmount: quoted.grossAmount,
      toAmount: quoted.amount,
      toAmountMin: quoted.amount,
      executionDuration: 120,
      gasCosts: quoted.nativeFee,
      feeCosts: quoted.grossAmount - quoted.amount,
      route: {
        warpRouteId: quoted.route.warpRouteId,
        sourceAdapter: quoted.route.source.addressOrDenom,
        destinationAdapter: quoted.route.destination.addressOrDenom,
        destinationDomain: Number(quoted.route.destinationMetadata.domainId),
        recipient: quoted.recipient,
        amount: quoted.amount,
        nativeFee: quoted.nativeFee,
      },
      requestParams: { ...params },
    };
  }

  private resolveRoute(
    fromChain: number,
    toChain: number,
    warpRouteId?: string,
  ): ResolvedRoute {
    const sourceMetadata = this.metadataByChainId.get(fromChain);
    const destinationMetadata = this.metadataByChainId.get(toChain);
    assert(sourceMetadata, `Missing metadata for source chain ${fromChain}`);
    assert(
      destinationMetadata,
      `Missing metadata for destination chain ${toChain}`,
    );
    this.protocol(sourceMetadata);
    this.protocol(destinationMetadata);

    for (const route of this.config.warpRoutes) {
      if (warpRouteId && route.id !== warpRouteId) continue;
      const source = route.config.tokens.find(
        (token) => token.chainName === sourceMetadata.name,
      );
      const destination = route.config.tokens.find(
        (token) => token.chainName === destinationMetadata.name,
      );
      if (!source || !destination) continue;
      const connected = source.connections?.some(
        (connection) =>
          connection.token.split('|')[1] === destination.chainName,
      );
      if (!connected) continue;
      assert(
        source.tokenType === 'collateralOft' &&
          destination.tokenType === 'collateralOft',
        `Warp route ${route.id} is not an OFT adapter route`,
      );
      return {
        warpRouteId: route.id,
        source,
        destination,
        sourceMetadata,
        destinationMetadata,
      };
    }
    throw new Error(
      `No configured OFT route supports ${sourceMetadata.name} -> ${destinationMetadata.name}`,
    );
  }

  private validateQuoteParams(params: BridgeQuoteParams): void {
    assert(
      params.fromChain !== params.toChain,
      'Source and destination must differ',
    );
    assert(
      (params.fromAmount === undefined) !== (params.toAmount === undefined),
      'Provide exactly one of fromAmount or toAmount',
    );
    assert(params.toAddress, 'OFT destination recipient is required');
  }

  private assertCosts(
    route: ResolvedRoute,
    amount: bigint,
    grossAmount: bigint,
    nativeFee: bigint,
  ): void {
    const fee = grossAmount - amount;
    const feeBps =
      fee === 0n
        ? 0n
        : (fee * BASIS_POINTS_DENOMINATOR + grossAmount - 1n) / grossAmount;
    assert(
      feeBps <= BigInt(this.maxFeeBps),
      `OFT fee too high: ${feeBps} bps. Max allowed: ${this.maxFeeBps} bps`,
    );
    const nativeCap =
      this.protocol(route.sourceMetadata) === ProtocolType.Tron
        ? this.maxTronNativeValueSun
        : this.maxEvmNativeValueWei;
    assert(
      nativeFee <= nativeCap,
      `OFT native fee ${nativeFee} exceeds cap ${nativeCap}`,
    );
  }

  private provider(metadata: ChainMetadata): ethers.providers.Provider {
    const rpcUrl = metadata.rpcUrls[0]?.http;
    assert(rpcUrl, `Missing RPC URL for ${metadata.name}`);
    return this.protocol(metadata) === ProtocolType.Tron
      ? new TronJsonRpcProvider(rpcUrl)
      : new ethers.providers.StaticJsonRpcProvider(rpcUrl, metadata.chainId);
  }

  private wallet(
    protocol: ProtocolType.Ethereum | ProtocolType.Tron,
    privateKey: string,
    metadata: ChainMetadata,
  ): ethers.Wallet {
    const provider = this.provider(metadata);
    return protocol === ProtocolType.Tron
      ? new TronWallet(privateKey, metadata.rpcUrls[0].http)
      : new ethers.Wallet(privateKey, provider);
  }

  private contract(
    address: string,
    signerOrProvider: ethers.Signer | ethers.providers.Provider,
  ): TokenBridgeOftContract {
    return (
      this.config.contractFactory?.(address, signerOrProvider) ??
      TokenBridgeOft__factory.connect(address, signerOrProvider)
    );
  }

  private protocol(
    metadata: ChainMetadata,
  ): ProtocolType.Ethereum | ProtocolType.Tron {
    assert(
      metadata.protocol === ProtocolType.Ethereum ||
        metadata.protocol === ProtocolType.Tron,
      `OFT inventory bridge does not support ${metadata.protocol}`,
    );
    return metadata.protocol;
  }

  private recipientBytes32(address: string): string {
    const bytes = address.startsWith('T')
      ? ethers.utils.hexlify(addressToBytesTron(address))
      : ethers.utils.getAddress(address);
    return ethers.utils.hexZeroPad(bytes, 32);
  }

  private normalizeHash(hash: string): string {
    return hash.startsWith('0x')
      ? hash.toLowerCase()
      : `0x${hash.toLowerCase()}`;
  }
}
