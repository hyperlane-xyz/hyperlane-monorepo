import {
  EVM,
  type RouteExtended,
  convertQuoteToRoute,
  createConfig,
  executeRoute,
  getQuote,
  getStatus,
  config as lifiConfig,
} from '@lifi/sdk';
import type { Signer } from 'ethers';
import type { Logger } from 'pino';
import { type Chain, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';

import type {
  BridgeQuote,
  BridgeQuoteParams,
  BridgeTransferResult,
  BridgeTransferStatus,
  ExternalBridgeConfig,
  IExternalBridge,
} from '../interfaces/IExternalBridge.js';

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
function getViemChain(chainId: number): Chain {
  const chain = VIEM_CHAINS[chainId];
  if (chain) {
    return chain;
  }

  // Fallback for chains not in our registry
  return {
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [] },
    },
  } as Chain;
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
  readonly bridgeId = 'lifi';
  readonly logger: Logger;
  private initialized = false;
  private readonly config: ExternalBridgeConfig;

  constructor(config: ExternalBridgeConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Initialize the LiFi SDK. Must be called before other methods.
   * Idempotent - safe to call multiple times.
   */
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
   * Get a quote for bridging tokens.
   * Returns route data ready for execution.
   */
  async quote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    this.initialize();
    this.logger.debug({ params }, 'Requesting LiFi quote');

    const quote = await getQuote({
      fromChain: params.fromChain,
      toChain: params.toChain,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.fromAmount.toString(),
      fromAddress: params.fromAddress,
      toAddress: params.toAddress ?? params.fromAddress,
      slippage: params.slippage ?? this.config.defaultSlippage ?? 0.005,
      // Prefer faster routes for rebalancing
      order: 'FASTEST',
    });

    this.logger.info(
      {
        quoteId: quote.id,
        tool: quote.tool,
        toAmount: quote.estimate.toAmount,
        toAmountMin: quote.estimate.toAmountMin,
        executionDuration: quote.estimate.executionDuration,
      },
      'LiFi quote received',
    );

    return {
      id: quote.id,
      tool: quote.tool,
      fromAmount: BigInt(quote.action.fromAmount),
      toAmount: BigInt(quote.estimate.toAmount),
      toAmountMin: BigInt(quote.estimate.toAmountMin),
      executionDuration: quote.estimate.executionDuration,
      route: quote, // Store full quote for conversion to route
    };
  }

  /**
   * Execute a bridge transfer using the SDK.
   * Handles approvals, transaction signing, and execution automatically.
   *
   * @param quote - Quote obtained from quote()
   * @param signer - Ethers Signer (must be a Wallet with private key access)
   */
  async execute(
    quote: BridgeQuote,
    signer: Signer,
  ): Promise<BridgeTransferResult> {
    this.initialize();

    // Convert quote to route for execution
    const route = convertQuoteToRoute(
      quote.route as Parameters<typeof convertQuoteToRoute>[0],
    );

    const fromChain = route.fromChainId;
    const toChain = route.toChainId;

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

    // Extract private key from ethers Signer (must be a Wallet)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const privateKey = (signer as any).privateKey as string | undefined;
    if (!privateKey) {
      throw new Error(
        'Signer must be an ethers Wallet with private key access for LiFi execution',
      );
    }

    // Create viem account and wallet client for the source chain
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const chain = getViemChain(fromChain);

    // Get RPC URL from signer's provider
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = signer.provider as any;
    const rpcUrl =
      provider?.connection?.url ?? provider?._getConnection?.()?.url;

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    this.logger.debug(
      {
        fromChain,
        chainName: chain.name,
        account: account.address,
      },
      'Created viem WalletClient for LiFi execution',
    );

    // Configure LiFi SDK with EVM provider that has our wallet client
    lifiConfig.setProviders([
      EVM({
        getWalletClient: async () => walletClient,
        switchChain: async (requiredChainId: number) => {
          // For backend usage, create a new client for the required chain
          const requiredChain = getViemChain(requiredChainId);
          return createWalletClient({
            account,
            chain: requiredChain,
            transport: http(),
          });
        },
      }),
    ]);

    let txHash: string | undefined;

    // Execute route with update callbacks
    const executedRoute = await executeRoute(route, {
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
