import {
  EVM,
  KeypairWalletAdapter,
  Solana,
  type LiFiStep,
  type Route,
  type RouteExtended,
  convertQuoteToRoute,
  createConfig,
  executeRoute,
  getQuote,
  getStatus,
  config as lifiConfig,
} from '@lifi/sdk';
import bs58 from 'bs58';
import type { ChainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType, ensure0x } from '@hyperlane-xyz/utils';
import type { Logger } from 'pino';
import { type Chain, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';
import { assert } from '@hyperlane-xyz/utils';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  ExternalBridgeConfig,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';
import { parseSolanaPrivateKey } from '../utils/solanaKeyParser.js';

/**
 * LiFi API base URL for REST endpoints.
 * The SDK doesn't support toAmount quotes, so we use REST API directly.
 */
const LIFI_API_BASE = 'https://li.quest/v1';

/**
 * Known chains for viem - add more as needed.
 * TODO: can we think of a cleaner way to do this?
 */
const VIEM_CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [arbitrum.id]: arbitrum,
  [base.id]: base,
  [optimism.id]: optimism,
};

/**
 * Get viem chain config by chain ID.
 * Falls back to a minimal chain config if not found.
 */
function getViemChain(chainId: number, rpcUrl?: string): Chain {
  const chain = VIEM_CHAINS[chainId];
  if (chain) {
    if (rpcUrl) {
      return { ...chain, rpcUrls: { default: { http: [rpcUrl] } } };
    }
    return chain;
  }

  // Fallback for chains not in our registry
  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: rpcUrl ? [rpcUrl] : [] },
    },
  } as Chain;
}

function toBase58SolanaKey(rawKey: string): string {
  const trimmedKey = rawKey.trim();
  if (!trimmedKey.startsWith('[') && !trimmedKey.includes(',')) {
    try {
      const decoded = bs58.decode(trimmedKey);
      if (decoded.length === 64) {
        return trimmedKey;
      }
    } catch {
      // Not valid base58, continue to parse as byte array
    }
  }

  const bytes = parseSolanaPrivateKey(trimmedKey);
  return bs58.encode(bytes);
}

/**
 * LiFi implementation of IExternalBridge using the official @lifi/sdk.
 *
 * The SDK provides:
 * - Automatic token approvals via executeRoute()
 * - Multi-step route handling (swap → bridge → swap)
 * - Built-in status tracking via getStatus()
 * - Native support for EVM, Solana, and other chains
 *
 * @see https://docs.li.fi/integrate-li.fi-sdk
 */
export class LiFiBridge implements IExternalBridge {
  private static readonly NATIVE_TOKEN_ADDRESS =
    '0x0000000000000000000000000000000000000000';

  readonly externalBridgeId = 'lifi';
  readonly logger: Logger;
  private initialized = false;
  private _executeLock: Promise<void> = Promise.resolve();
  private readonly config: ExternalBridgeConfig;
  private readonly chainMetadataByChainId: Map<number, ChainMetadata>;

  constructor(config: ExternalBridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    // Build chainId -> metadata map for O(1) lookups
    this.chainMetadataByChainId = new Map();
    if (config.chainMetadata) {
      for (const metadata of Object.values(config.chainMetadata)) {
        if (metadata.chainId !== undefined) {
          this.chainMetadataByChainId.set(Number(metadata.chainId), metadata);
        }
      }
    }
  }

  getNativeTokenAddress(): string {
    return LiFiBridge.NATIVE_TOKEN_ADDRESS;
  }

  private initialize(): void {
    if (this.initialized) return;

    createConfig({
      integrator: this.config.integrator,
      apiKey: this.config.apiKey,
    });

    this.initialized = true;
    this.logger.info(
      { integrator: this.config.integrator },
      'LiFi SDK initialized',
    );
  }

  /**
   * Resolve RPC URL for a given EVM chainId from chain metadata.
   * Iterates metadata to find matching chainId and returns first HTTP RPC URL.
   */
  private getRpcUrlForChainId(chainId: number): string | undefined {
    return this.chainMetadataByChainId.get(chainId)?.rpcUrls?.[0]?.http;
  }

  private getProtocolTypeForChainId(chainId: number): ProtocolType | undefined {
    return this.chainMetadataByChainId.get(chainId)?.protocol;
  }

  private addressesEqual(a: string, b: string, chainId: number): boolean {
    const protocol = this.getProtocolTypeForChainId(chainId);
    // Default to case-insensitive when protocol is unknown (e.g. no chain metadata)
    // since LiFi primarily serves EVM chains with hex addresses.
    if (!protocol || protocol === ProtocolType.Ethereum) {
      return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
  }

  /**
   * Configure LiFi SDK providers from the given private keys.
   * Sets up wallet/signer for each protocol type present in the keys map.
   */
  private configureLiFiProviders(
    privateKeys: Partial<Record<ProtocolType, string>>,
    fromChain: number,
    fromRpcUrl: string | undefined,
  ): void {
    const providers: Parameters<typeof lifiConfig.setProviders>[0] = [];
    for (const [protocol, key] of Object.entries(privateKeys)) {
      switch (protocol) {
        case ProtocolType.Ethereum: {
          const account = privateKeyToAccount(ensure0x(key) as `0x${string}`);
          const chain = getViemChain(fromChain, fromRpcUrl);
          const walletClient = createWalletClient({
            account,
            chain,
            transport: http(fromRpcUrl),
          });
          providers.push(
            EVM({
              getWalletClient: async () => walletClient,
              switchChain: async (requiredChainId: number) => {
                const switchRpcUrl = this.getRpcUrlForChainId(requiredChainId);
                const requiredChain = getViemChain(
                  requiredChainId,
                  switchRpcUrl,
                );
                return createWalletClient({
                  account,
                  chain: requiredChain,
                  transport: http(switchRpcUrl),
                });
              },
            }),
          );
          break;
        }
        case ProtocolType.Sealevel: {
          const base58Key = toBase58SolanaKey(key);
          providers.push(
            Solana({
              getWalletAdapter: async () => new KeypairWalletAdapter(base58Key),
            }),
          );
          break;
        }
        default:
          throw new Error(
            `Unsupported protocol type '${protocol}' for LiFi provider`,
          );
      }
    }

    lifiConfig.setProviders(providers);

    this.logger.debug(
      {
        fromChain,
        protocols: Object.keys(privateKeys),
      },
      'Configured LiFi providers for route execution',
    );
  }

  /**
   * Get a quote for bridging tokens.
   * Supports two modes:
   * - fromAmount: "I'm sending X, what do I get?" (uses SDK)
   * - toAmount: "I want X, how much do I send?" (uses REST API)
   *
   * Returns route data ready for execution.
   */
  async quote(params: BridgeQuoteParams): Promise<BridgeQuote<LiFiStep>> {
    this.initialize();

    // Validate that exactly one of fromAmount or toAmount is provided
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

    // Dispatch to appropriate quote method
    if (params.toAmount !== undefined) {
      return this.quoteByReceivingAmount(params);
    } else {
      return this.quoteBySpendingAmount(params);
    }
  }

  /**
   * Get a quote by specifying the amount to send (standard quote).
   * Uses the LiFi SDK.
   */
  private async quoteBySpendingAmount(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<LiFiStep>> {
    this.logger.debug({ params }, 'Requesting LiFi quote by spending amount');

    const quote = await getQuote({
      fromChain: params.fromChain,
      toChain: params.toChain,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.fromAmount!.toString(),
      fromAddress: params.fromAddress,
      toAddress: params.toAddress ?? params.fromAddress,
      slippage: params.slippage ?? this.config.defaultSlippage ?? 0.005,
      // Prefer faster routes for rebalancing
      order: 'RECOMMENDED',
    });

    const { gasCosts, feeCosts } = this.extractCosts(quote);

    this.logger.info(
      {
        quoteId: quote.id,
        tool: quote.tool,
        fromAmount: quote.action.fromAmount,
        toAmount: quote.estimate.toAmount,
        toAmountMin: quote.estimate.toAmountMin,
        executionDuration: quote.estimate.executionDuration,
        gasCosts: gasCosts.toString(),
        feeCosts: feeCosts.toString(),
      },
      'LiFi quote received (fromAmount)',
    );

    return {
      id: quote.id,
      tool: quote.tool,
      fromAmount: BigInt(quote.action.fromAmount),
      toAmount: BigInt(quote.estimate.toAmount),
      toAmountMin: BigInt(quote.estimate.toAmountMin),
      executionDuration: quote.estimate.executionDuration,
      gasCosts,
      feeCosts,
      route: quote, // Store full quote for conversion to route
      requestParams: { ...params },
    };
  }

  /**
   * Get a quote by specifying the amount to receive (reverse quote).
   * Uses the LiFi REST API directly since the SDK doesn't support toAmount.
   */
  private async quoteByReceivingAmount(
    params: BridgeQuoteParams,
  ): Promise<BridgeQuote<LiFiStep>> {
    this.logger.debug({ params }, 'Requesting LiFi quote by receiving amount');

    const queryParams = new URLSearchParams({
      fromChain: params.fromChain.toString(),
      toChain: params.toChain.toString(),
      fromToken: params.fromToken,
      toToken: params.toToken,
      toAmount: params.toAmount!.toString(),
      fromAddress: params.fromAddress,
      toAddress: params.toAddress ?? params.fromAddress,
      slippage: (params.slippage ?? this.config.defaultSlippage ?? 0.005)
        .toFixed(4)
        .replace(/\.?0+$/, ''),
      order: 'CHEAPEST',
      integrator: this.config.integrator,
    });

    if (this.config.apiKey) {
      queryParams.set('apiKey', this.config.apiKey);
    }

    const url = `${LIFI_API_BASE}/quote/toAmount?${queryParams.toString()}`;
    this.logger.debug(
      { url: url.replace(/apiKey=[^&]+/, 'apiKey=***') },
      'Fetching LiFi toAmount quote',
    );

    const response = await fetch(url);
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `LiFi toAmount quote failed: ${response.status} ${response.statusText} - ${errorBody}`,
      );
    }

    const quote: LiFiStep = await response.json();
    const { gasCosts, feeCosts } = this.extractCosts(quote);

    this.logger.info(
      {
        quoteId: quote.id,
        tool: quote.tool,
        fromAmount: quote.action.fromAmount,
        toAmount: quote.estimate.toAmount,
        toAmountMin: quote.estimate.toAmountMin,
        executionDuration: quote.estimate.executionDuration,
        gasCosts: gasCosts.toString(),
        feeCosts: feeCosts.toString(),
      },
      'LiFi quote received (toAmount)',
    );

    return {
      id: quote.id,
      tool: quote.tool,
      fromAmount: BigInt(quote.action.fromAmount),
      toAmount: BigInt(quote.estimate.toAmount),
      toAmountMin: BigInt(quote.estimate.toAmountMin),
      executionDuration: quote.estimate.executionDuration,
      gasCosts,
      feeCosts,
      route: quote, // Store full quote for conversion to route
      requestParams: { ...params },
    };
  }

  /**
   * Extract gas and fee costs from a LiFi quote response.
   * - gasCosts: Sum of all gas costs (transaction fees)
   * - feeCosts: Sum of non-included fee costs (protocol fees not deducted from amount)
   */
  private extractCosts(quote: LiFiStep): {
    gasCosts: bigint;
    feeCosts: bigint;
  } {
    let gasCosts = 0n;
    let feeCosts = 0n;

    // Sum up gas costs
    if (quote.estimate.gasCosts) {
      for (const cost of quote.estimate.gasCosts) {
        gasCosts += BigInt(cost.amount);
      }
    }

    // Sum up non-included fee costs
    // (included fees are already deducted from toAmount, so we only count non-included)
    if (quote.estimate.feeCosts) {
      for (const cost of quote.estimate.feeCosts) {
        if (!cost.included) {
          feeCosts += BigInt(cost.amount);
        }
      }
    }

    return { gasCosts, feeCosts };
  }

  /**
   * Execute a bridge transfer using the SDK.
   * Handles approvals, transaction signing, and execution automatically.
   *
   * @param quote - Quote obtained from quote()
   * @param privateKeys - Private keys keyed by protocol type for signing transactions
   */
  async execute(
    quote: BridgeQuote<LiFiStep>,
    privateKeys: Partial<Record<ProtocolType, string>>,
  ): Promise<BridgeTransferResult> {
    this.initialize();

    // Convert quote to route for execution
    const route = convertQuoteToRoute(quote.route);

    this.validateRouteAgainstRequest(route, quote.requestParams);

    const fromChain = route.fromChainId;
    const toChain = route.toChainId;
    const fromProtocol = this.getProtocolTypeForChainId(fromChain);
    assert(
      privateKeys[fromProtocol ?? ProtocolType.Ethereum],
      `Missing private key for source chain protocol ${fromProtocol ?? ProtocolType.Ethereum}`,
    );

    this.logger.info(
      {
        quoteId: quote.id,
        tool: quote.tool,
        fromChain,
        toChain,
        fromAmount: quote.fromAmount.toString(),
      },
      'Executing LiFi bridge transfer',
    );

    const fromRpcUrl = this.getRpcUrlForChainId(fromChain);

    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this._executeLock;
    this._executeLock = acquired;
    await prev;

    let txHash: string | undefined;
    let executedRoute!: RouteExtended;

    try {
      this.configureLiFiProviders(privateKeys, fromChain, fromRpcUrl);

      this.logger.debug(
        {
          fromChain,
          protocols: Object.keys(privateKeys),
        },
        'Configured LiFi providers for route execution',
      );

      // Execute route with update callbacks
      executedRoute = await executeRoute(route, {
        // Update callback for route progress
        updateRouteHook: (updatedRoute: RouteExtended) => {
          this.logger.debug(
            { step: updatedRoute.steps[0]?.id },
            'Route step updated',
          );

          // Extract txHash from execution if available (RouteExtended has LiFiStepExtended with execution)
          const execution = updatedRoute.steps[0]?.execution;
          if (execution?.process) {
            for (const process of execution.process) {
              if (process.txHash) {
                txHash = process.txHash;
              }
            }
          }
        },
        // Auto-accept rate updates for rebalancing
        acceptExchangeRateUpdateHook: async () => true,
      });
    } finally {
      release();
    }

    // Extract txHash from executed route if not captured in callbacks
    if (!txHash) {
      const execution = executedRoute.steps[0]?.execution;
      if (execution?.process) {
        for (const process of execution.process) {
          if (process.txHash) {
            txHash = process.txHash;
            break;
          }
        }
      }
    }

    if (!txHash) {
      throw new Error('No transaction hash found in executed route');
    }

    this.logger.info(
      { txHash, quoteId: quote.id },
      'LiFi bridge transaction executed',
    );

    // Extract transfer ID if available (some bridges provide this)
    let transferId: string | undefined;
    const processes = executedRoute.steps[0]?.execution?.process;
    const txInfo = processes?.find((p) => p.txHash === txHash);
    if (txInfo && 'lifiExplorerLink' in txInfo) {
      // Extract transfer ID from explorer link if available
      const link = (txInfo as { lifiExplorerLink?: string }).lifiExplorerLink;
      const match = link?.match(/\/tx\/([^/]+)/);
      if (match) {
        transferId = match[1];
      }
    }

    return {
      txHash,
      fromChain,
      toChain,
      transferId,
    };
  }

  /**
   * Validate that the route returned by LiFi matches the original request parameters.
   * Prevents execution against wrong chains, tokens, or recipients if the bridge API
   * returns a route that diverges from what was originally requested.
   *
   * TODO: Layer 2 validation — validate transaction calldata in route.steps[].transactionRequest
   * and route.steps[0].estimate.approvalAddress against a known whitelist.
   */
  private validateRouteAgainstRequest(
    route: Route,
    requestParams: BridgeQuoteParams,
  ): void {
    assert(
      route.fromChainId === requestParams.fromChain,
      `Route fromChainId ${route.fromChainId} does not match requested ${requestParams.fromChain}`,
    );
    assert(
      route.toChainId === requestParams.toChain,
      `Route toChainId ${route.toChainId} does not match requested ${requestParams.toChain}`,
    );
    assert(
      this.addressesEqual(
        route.fromToken.address,
        requestParams.fromToken,
        route.fromChainId,
      ),
      `Route fromToken ${route.fromToken.address} does not match requested ${requestParams.fromToken}`,
    );
    assert(
      this.addressesEqual(
        route.toToken.address,
        requestParams.toToken,
        route.toChainId,
      ),
      `Route toToken ${route.toToken.address} does not match requested ${requestParams.toToken}`,
    );
    const expectedToAddress =
      requestParams.toAddress ?? requestParams.fromAddress;
    assert(
      this.addressesEqual(
        route.toAddress ?? '',
        expectedToAddress,
        route.toChainId,
      ),
      `Route toAddress ${route.toAddress} does not match requested ${expectedToAddress}`,
    );
    assert(
      this.addressesEqual(
        route.fromAddress ?? '',
        requestParams.fromAddress,
        route.fromChainId,
      ),
      `Route fromAddress ${route.fromAddress} does not match requested ${requestParams.fromAddress}`,
    );
    const routeFromAmount = BigInt(route.fromAmount);
    if (requestParams.fromAmount !== undefined) {
      assert(
        routeFromAmount === requestParams.fromAmount,
        `Route fromAmount ${route.fromAmount} does not match requested ${requestParams.fromAmount}`,
      );
    }
    if (requestParams.toAmount !== undefined) {
      const routeToAmount = BigInt(route.toAmount);
      assert(
        routeToAmount >= requestParams.toAmount,
        `Route toAmount ${route.toAmount} is less than requested ${requestParams.toAmount}`,
      );
    }
    assert(routeFromAmount > 0n, 'Route fromAmount must be positive');
  }

  /**
   * Get the status of a bridge transfer.
   * Uses SDK's built-in status tracking.
   */
  async getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus> {
    this.initialize();

    try {
      const status = await getStatus({
        txHash,
        fromChain,
        toChain,
      });

      switch (status.status) {
        case 'DONE': {
          // receiving can be PendingReceivingInfo (only chainId) or ExtendedTransactionInfo (has txHash, amount)
          const receiving = status.receiving;
          const receivingTxHash =
            receiving && 'txHash' in receiving ? (receiving.txHash ?? '') : '';
          const receivedAmount =
            receiving && 'amount' in receiving
              ? BigInt(receiving.amount ?? '0')
              : BigInt(0);
          return {
            status: 'complete',
            receivingTxHash,
            receivedAmount,
          };
        }

        case 'FAILED':
          return {
            status: 'failed',
            error: status.substatus,
          };

        case 'NOT_FOUND':
        case 'INVALID':
          return { status: 'not_found' };

        case 'PENDING':
        default:
          return {
            status: 'pending',
            substatus: status.substatus,
          };
      }
    } catch (error) {
      this.logger.warn({ txHash, error }, 'Failed to get LiFi status');
      return { status: 'not_found' };
    }
  }
}
