import { pino, type Logger } from 'pino';
import { RoutingClient } from './client/RoutingClient.js';
import type {
  ChainsResponse,
  QuoteRequest,
  QuoteResponse,
  TokensQuery,
  TokensResponse,
} from './client/schemas.js';
import { executeSwap } from './swap/executor.js';
import { SwapTracker } from './swap/tracker.js';
import type { WalletConfig } from './wallet/types.js';
import type { MetaswapsSDKConfig, SwapHandle } from './types.js';
import {
  DEFAULT_CCS_URL,
  DEFAULT_EXPLORER_API_URL,
  DEFAULT_POLLING_INTERVAL_MS,
  DEFAULT_ROUTING_URL,
  resolveRpcUrl,
} from './utils/constants.js';
import { assert, randomUUID } from './utils.js';

export class MetaswapsSDK {
  private readonly routingClient: RoutingClient;
  private readonly config: {
    routingUrl: string;
    ccsUrl: string;
    explorerApiUrl: string;
    pollingInterval: number;
    chainRpcUrls: Record<number, string>;
    logger: Logger;
  };

  constructor(config: MetaswapsSDKConfig = {}) {
    const routingUrl = config.routingUrl ?? DEFAULT_ROUTING_URL;
    this.routingClient = new RoutingClient(routingUrl);
    this.config = {
      routingUrl,
      ccsUrl: config.ccsUrl ?? DEFAULT_CCS_URL,
      explorerApiUrl: config.explorerApiUrl ?? DEFAULT_EXPLORER_API_URL,
      pollingInterval: config.pollingInterval ?? DEFAULT_POLLING_INTERVAL_MS,
      chainRpcUrls: config.chainRpcUrls ?? {},
      logger: config.logger ?? pino({ level: 'info' }),
    };
  }

  // Returns the list of chains supported by the routing engine.
  async chains(): Promise<ChainsResponse['chains']> {
    const response = await this.routingClient.chains();
    return response.chains;
  }

  // Returns tokens available on a specific chain (or across chains).
  tokens(query?: TokensQuery): Promise<TokensResponse> {
    return this.routingClient.tokens(query);
  }

  // Fetches a swap quote. Uses EVM chain IDs (not Hyperlane domain IDs).
  quote(params: QuoteRequest): Promise<QuoteResponse> {
    return this.routingClient.quote(params);
  }

  // Executes the best route from a quote and returns a live SwapHandle
  // for tracking status via promises or async iteration.
  //
  // This method:
  //   1. Checks and submits ERC-20 approval if needed.
  //   2. Registers the destination swap commitment with CCS (if route requires it).
  //   3. Broadcasts the origin transaction.
  //   4. Returns a SwapHandle immediately; tracking runs in the background.
  async swap(quote: QuoteResponse, wallet: WalletConfig): Promise<SwapHandle> {
    assert(quote.routes.length > 0, 'Quote contains no routes');

    const rpcUrls = this.buildRpcMap(quote);
    const tracker = new SwapTracker(
      this.config.pollingInterval,
      this.config.explorerApiUrl,
    );

    const originTxHash = await executeSwap(
      quote,
      wallet,
      {
        ccsUrl: this.config.ccsUrl,
        chainRpcUrls: rpcUrls,
      },
      tracker,
    );

    const id = randomUUID();

    return {
      id,
      originTxHash,
      get status() {
        return tracker.status;
      },
      originConfirmed: tracker.originConfirmed,
      delivered: tracker.delivered,
      watch: (intervalMs?: number) => tracker.watch(intervalMs),
      cancel: () => tracker.cancel(),
    };
  }

  // Expose the underlying RoutingClient for advanced use (e.g. readiness checks).
  get client(): RoutingClient {
    return this.routingClient;
  }

  // Merges user-supplied RPC overrides with defaults, covering all chains in the quote.
  private buildRpcMap(quote: QuoteResponse): Record<number, string> {
    const result: Record<number, string> = { ...this.config.chainRpcUrls };
    for (const route of quote.routes) {
      for (const step of route.steps) {
        const chainId = step.chain;
        if (!result[chainId]) {
          const url = resolveRpcUrl(chainId, this.config.chainRpcUrls);
          if (url) result[chainId] = url;
        }
        if (step.type === 'bridge' && !result[step.destChain]) {
          const url = resolveRpcUrl(step.destChain, this.config.chainRpcUrls);
          if (url) result[step.destChain] = url;
        }
      }
    }
    return result;
  }
}
