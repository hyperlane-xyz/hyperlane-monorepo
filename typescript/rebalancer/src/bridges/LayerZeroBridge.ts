import { ethers } from 'ethers';
import type { Logger } from 'pino';
import { z } from 'zod';

import { TokenBridgeOft__factory } from '@hyperlane-xyz/core';
import {
  ChainStatus,
  type ChainMap,
  type ChainMetadata,
  type WarpCoreConfig,
  submitEvmLikeTransaction,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  TransactionSubmission,
  convertToProtocolAddress,
  addressToBytes32,
  assert,
  eqAddress,
} from '@hyperlane-xyz/utils';
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
import {
  OftSettlementVerifier,
  normalizeTxHash,
} from './OftSettlementVerifier.js';

const LAYERZERO_TOOL = 'layerzero';
const MAX_QUOTE_ATTEMPTS = 8;
const BASIS_POINTS_DENOMINATOR = 10_000n;
const DEFAULT_MAX_FEE_BPS = 50;
const DEFAULT_MAX_EVM_NATIVE_VALUE_WEI = 10_000_000_000_000_000n;
const DEFAULT_MAX_TRON_NATIVE_VALUE_SUN = 20_000_000n;

const TransferIdentitySchema = z.object({
  warpRouteId: z.string(),
  fromChain: z.number(),
  toChain: z.number(),
  sourceEid: z.number().int().positive(),
  destinationEid: z.number().int().positive(),
  sourceOft: z.string(),
  destinationOft: z.string(),
  destinationRecipient: z.string(),
  minimumDestinationAmount: z.string().regex(/^\d+$/),
});

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
  oft(): Promise<string>;
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
  /** Inventory OFT quoting supports routes with equal source/destination local decimals. */
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
  private readonly maxFeeBps: number;
  private readonly maxEvmNativeValueWei: bigint;
  private readonly maxTronNativeValueSun: bigint;
  private readonly settlement: OftSettlementVerifier;

  constructor(
    private readonly config: LayerZeroBridgeConfig,
    logger: Logger,
  ) {
    this.logger = logger;
    this.settlement = new OftSettlementVerifier({ logger });
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
      if (
        metadata.chainId === undefined ||
        metadata.availability?.status === ChainStatus.Disabled ||
        (metadata.protocol !== ProtocolType.Ethereum &&
          metadata.protocol !== ProtocolType.Tron)
      ) {
        continue;
      }
      const chainId = Number(metadata.chainId);
      assert(
        Number.isSafeInteger(chainId),
        `Invalid chain ID for ${metadata.name}`,
      );
      assert(
        !this.metadataByChainId.has(chainId),
        `Duplicate chain metadata for chain ID ${chainId}`,
      );
      this.metadataByChainId.set(chainId, metadata);
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

  execute(
    quote: BridgeQuote<LayerZeroQuoteRoute>,
    privateKeys: Partial<Record<ProtocolType, string>>,
    options?: BridgeExecutionOptions,
  ): Promise<BridgeTransferResult> {
    return new TransactionSubmission(options).run((observers) =>
      this.executeTransfer(quote, privateKeys, { ...options, ...observers }),
    );
  }

  private async executeTransfer(
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
      eqAddress(evmAddress(sender), evmAddress(params.fromAddress)),
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

    // Persist the expected beneficiary and amount before any source submission.
    // An ambiguous broadcast must remain verifiable without execute() returning.
    const sourceContract = this.contract(
      route.source.addressOrDenom,
      this.provider(route.sourceMetadata),
    );
    const destinationContract = this.contract(
      route.destination.addressOrDenom,
      this.provider(route.destinationMetadata),
    );
    const [sourceOft, destinationOft, sourceEid, destinationEid] =
      await Promise.all([
        sourceContract.oft(),
        destinationContract.oft(),
        destinationContract.hyperlaneDomainToLzEid(
          Number(route.sourceMetadata.domainId),
        ),
        sourceContract.hyperlaneDomainToLzEid(
          Number(route.destinationMetadata.domainId),
        ),
      ]);
    const transferId = JSON.stringify({
      warpRouteId: route.warpRouteId,
      fromChain: params.fromChain,
      toChain: params.toChain,
      sourceEid,
      destinationEid,
      sourceOft: evmAddress(sourceOft),
      destinationOft: evmAddress(destinationOft),
      destinationRecipient: evmAddress(params.toAddress ?? params.fromAddress),
      minimumDestinationAmount: quote.toAmountMin.toString(),
    });
    await options?.onTransferId?.(transferId);

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
    const response = await submitEvmLikeTransaction(wallet, request, options);

    return {
      txHash: response.hash,
      fromChain: params.fromChain,
      toChain: params.toChain,
      transferId,
    };
  }

  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
    transferId?: string,
  ): Promise<BridgeTransferStatus> {
    // Old/missing identities cannot establish the accepted recipient. Never
    // turn an unbound API result into permission to spend inventory again.
    if (!transferId)
      return { status: 'pending', substatus: 'IDENTITY_MISSING' };
    try {
      const identity = TransferIdentitySchema.parse(JSON.parse(transferId));
      assert(
        identity.fromChain === fromChain && identity.toChain === toChain,
        'LayerZero settlement chain mismatch',
      );
      const route = this.resolveRoute(fromChain, toChain, identity.warpRouteId);
      const sourceProvider = this.provider(route.sourceMetadata);
      const sourceReceipt = await sourceProvider.getTransactionReceipt(
        normalizeTxHash(txHash),
      );
      if (!sourceReceipt || sourceReceipt.status !== 1) {
        return { status: 'pending', substatus: 'SOURCE_RECEIPT_UNVERIFIED' };
      }
      if (
        sourceProvider instanceof TronJsonRpcProvider &&
        sourceReceipt.blockNumber >
          (await sourceProvider.getFinalizedBlockNumber())
      ) {
        return { status: 'pending', substatus: 'SOURCE_NOT_FINAL' };
      }
      const blocks = route.sourceMetadata.blocks;
      if (sourceReceipt.confirmations < (blocks?.confirmations ?? 1)) {
        return { status: 'pending', substatus: 'SOURCE_NOT_FINAL' };
      }
      const reorgPeriod = blocks?.reorgPeriod ?? 32;
      if (typeof reorgPeriod === 'number') {
        if (sourceReceipt.confirmations <= reorgPeriod) {
          return { status: 'pending', substatus: 'SOURCE_NOT_FINAL' };
        }
      } else if (!(sourceProvider instanceof TronJsonRpcProvider)) {
        const finalized = await sourceProvider.getBlock(reorgPeriod);
        if (!finalized || sourceReceipt.blockNumber > finalized.number) {
          return { status: 'pending', substatus: 'SOURCE_NOT_FINAL' };
        }
      }
      const ref = await this.settlement.initFromReceipt({
        ...identity,
        destination: route.destinationMetadata.name,
        destinationDomain: Number(route.destinationMetadata.domainId),
        bridge: evmAddress(route.source.addressOrDenom),
        sourceTokenDecimals: route.source.decimals,
        destinationTokenDecimals: route.destination.decimals,
        minimumDestinationAmount: BigInt(identity.minimumDestinationAmount),
        receipt: sourceReceipt,
      });
      const provider = this.provider(route.destinationMetadata);
      const destinationBlocks = route.destinationMetadata.blocks;
      const destinationReorgPeriod = destinationBlocks?.reorgPeriod ?? 32;
      const blockTag =
        typeof destinationReorgPeriod === 'number'
          ? Math.max(
              0,
              (await provider.getBlockNumber()) - destinationReorgPeriod,
            )
          : provider instanceof TronJsonRpcProvider
            ? await provider.getFinalizedBlockNumber()
            : (await provider.getBlock(destinationReorgPeriod))?.number;
      if (blockTag === undefined)
        return { status: 'pending', substatus: 'DESTINATION_NOT_FINAL' };
      const status = await this.settlement.pollStatus(ref, {
        provider,
        blocks: destinationBlocks,
        blockTag,
      });
      if (status.status === 'complete') {
        const amount = status.ref.data.amountReceivedLD;
        assert(typeof amount === 'string', 'Verified OFT amount missing');
        return {
          status: 'complete',
          receivingTxHash: status.receivingTxHash,
          receivedAmount: BigInt(amount),
        };
      }
      return { status: 'pending', substatus: status.substatus };
    } catch (error) {
      this.logger.warn(
        { txHash, fromChain, toChain, error },
        'LayerZero settlement remains unverified',
      );
      return { status: 'pending', substatus: 'SETTLEMENT_UNVERIFIED' };
    }
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
      eqAddress(evmAddress(sourceToken), evmAddress(params.fromToken)),
      `OFT source token mismatch: ${sourceToken}`,
    );
    assert(
      eqAddress(evmAddress(destinationToken), evmAddress(params.toToken)),
      `OFT destination token mismatch: ${destinationToken}`,
    );
    const nativeQuotes = quotes.filter(
      (quote) => quote.token === ethers.constants.AddressZero,
    );
    const tokenQuotes = quotes.filter(
      (quote) =>
        quote.token !== ethers.constants.AddressZero &&
        eqAddress(evmAddress(quote.token), evmAddress(sourceToken)),
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
      assert(
        source.decimals === destination.decimals,
        `OFT inventory route ${route.id} requires equal local token decimals`,
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
    return addressToBytes32(address);
  }
}

function evmAddress(address: string): string {
  return convertToProtocolAddress(address, ProtocolType.Ethereum);
}
