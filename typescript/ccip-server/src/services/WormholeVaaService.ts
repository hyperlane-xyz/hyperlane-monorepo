import { ethers } from 'ethers';
import { Logger } from 'pino';
import { z } from 'zod';

import {
  IWormholeVaaService__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, parseMessage, sleep } from '@hyperlane-xyz/utils';

import type { CcipApp } from '../http.js';
import {
  ABI_ROUTE_OPTIONS,
  type AbiRoute,
  createAbiHandler,
} from '../utils/abiHandler.js';
import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';
import { RpcUnavailableError } from '../utils/rpcErrors.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';
import {
  VaaPendingError,
  WormholeVaaFetcher,
  redactEndpointUrl,
} from './WormholeVaaFetcher.js';
import {
  type ParsedVaa,
  type WormholePublication,
  assertVaaMatchesPublication,
  findMatchingWormholePublication,
  formatVaaId,
} from './wormholeVaaMatcher.js';
import {
  type WormholeChainConfig,
  resolveWormholeRoutes,
} from './wormholeRouteResolver.js';

const CommaSeparatedUrls = z
  .string()
  .transform((value) => value.split(',').map((url) => url.trim()))
  .pipe(z.array(z.string().url()).min(1));

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  /** Comma-separated Wormholescan-compatible base URLs. */
  WORMHOLE_VAA_URLS: CommaSeparatedUrls,
  WORMHOLE_VAA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WORMHOLE_VAA_MAX_BYTES: z.coerce.number().int().positive().default(65_536),
  WORMHOLE_VAA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  WORMHOLE_VAA_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000),
});

const VaaEndpointFailure = {
  Pending: 'pending',
  Unavailable: 'unavailable',
  Mismatch: 'mismatch',
} as const;
type VaaEndpointFailure =
  (typeof VaaEndpointFailure)[keyof typeof VaaEndpointFailure];

/** Why one endpoint did not produce a matching VAA in one round. */
class VaaEndpointError extends Error {
  constructor(
    readonly url: string,
    readonly failure: VaaEndpointFailure,
    readonly reason: unknown,
  ) {
    super(
      `${redactEndpointUrl(url)}: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    this.name = 'VaaEndpointError';
  }
}

/** The one `HyperlaneService` capability this service needs. */
export interface OriginTransactionResolver {
  getOriginTransactionHashByMessageId(
    id: string,
    logger: Logger,
  ): Promise<string>;
}

export interface WormholeVaaServiceConfig extends ServiceConfigWithMultiProvider {
  /** Redundant Wormholescan-compatible base URLs, queried in parallel. */
  vaaUrls: Array<string>;
  /** Rounds over every endpoint while a VAA is pending Guardian signatures. */
  maxAttempts: number;
  baseRetryDelayMs: number;
  vaaFetcher: Pick<WormholeVaaFetcher, 'fetchVaa'>;
  hyperlaneService: OriginTransactionResolver;
}

/**
 * CCIP-read service resolving the Wormhole VAA that authenticates a Hyperlane
 * message for `WormholeVaaHookIsm`.
 *
 * The service is untrusted transport. It cannot forge Guardian signatures, and
 * destination Core re-verifies everything it returns. Its job is availability:
 * find the one publication that belongs to this message, fetch its VAA, and
 * re-check the VAA against that publication before answering.
 */
export class WormholeVaaService extends BaseService {
  private readonly multiProvider: MultiProvider;
  private readonly vaaUrls: Array<string>;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly vaaFetcher: Pick<WormholeVaaFetcher, 'fetchVaa'>;
  private readonly hyperlaneService: OriginTransactionResolver;

  static async create(serviceName: string): Promise<WormholeVaaService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new WormholeVaaService({
      serviceName,
      multiProvider,
      vaaUrls: env.WORMHOLE_VAA_URLS,
      maxAttempts: env.WORMHOLE_VAA_MAX_ATTEMPTS,
      baseRetryDelayMs: env.WORMHOLE_VAA_RETRY_DELAY_MS,
      vaaFetcher: new WormholeVaaFetcher(serviceName, {
        timeoutMs: env.WORMHOLE_VAA_TIMEOUT_MS,
        maxResponseBytes: env.WORMHOLE_VAA_MAX_BYTES,
      }),
      hyperlaneService: new HyperlaneService(
        serviceName,
        env.HYPERLANE_EXPLORER_URL,
      ),
    });
  }

  constructor(config: WormholeVaaServiceConfig) {
    super(config);
    assert(config.vaaUrls.length > 0, 'At least one VAA endpoint is required');
    assert(
      config.maxAttempts > 0,
      'At least one VAA lookup attempt is required',
    );
    this.multiProvider = config.multiProvider;
    this.vaaUrls = config.vaaUrls;
    this.maxAttempts = config.maxAttempts;
    this.baseRetryDelayMs = config.baseRetryDelayMs;
    this.vaaFetcher = config.vaaFetcher;
    this.hyperlaneService = config.hyperlaneService;
  }

  registerRoutes(app: CcipApp, prefix: string): void {
    // CCIP-read spec: GET /getWormholeVaa/:sender/:callData.json
    app.get<AbiRoute>(
      `${prefix}/getWormholeVaa/:sender/:callData.json`,
      ABI_ROUTE_OPTIONS,
      async (request, reply) =>
        createAbiHandler(
          IWormholeVaaService__factory,
          'getWormholeVaa',
          (message: string, logger: Logger) =>
            this.getWormholeVaa(
              message,
              request.params.sender,
              undefined,
              logger,
            ),
        )(request, reply),
    );

    // CCIP-read spec: POST /getWormholeVaa
    app.post<AbiRoute>(
      `${prefix}/getWormholeVaa`,
      ABI_ROUTE_OPTIONS,
      async (request, reply) => {
        const rawTxHash = request.body?.origin_tx_hash;
        const originTxHash =
          typeof rawTxHash === 'string' &&
          ethers.utils.isHexString(rawTxHash, 32)
            ? rawTxHash
            : undefined;
        const requestRouter = request.body?.sender;
        return createAbiHandler(
          IWormholeVaaService__factory,
          'getWormholeVaa',
          (message: string, logger: Logger) =>
            this.getWormholeVaa(message, requestRouter, originTxHash, logger),
        )(request, reply);
      },
    );
  }

  async getWormholeVaa(
    message: string,
    requestRouter: unknown,
    originTxHash: string | undefined,
    logger: Logger,
  ): Promise<string> {
    const log = this.addLoggerServiceContext(logger);

    const messageId = ethers.utils.keccak256(message);
    const parsed = parseMessage(message);
    log.info(
      {
        messageId,
        origin: parsed.origin,
        destination: parsed.destination,
        nonce: parsed.nonce,
      },
      'Processing Wormhole VAA request',
    );

    const { origin, destination } = await this.routesFor(
      parsed.origin,
      parsed.destination,
      requestRouter,
      log,
    );

    const txHash = await this.resolveOriginTxHash(originTxHash, messageId, log);

    const receipt = await this.multiProvider
      .getProvider(parsed.origin)
      .getTransactionReceipt(txHash);
    assert(receipt, `No receipt found for origin transaction ${txHash}`);

    const publication = this.findPublication(receipt.logs, {
      coreAddress: origin.core,
      originRouter: ethers.utils.hexZeroPad(origin.router, 32),
      destinationRouter: ethers.utils.hexZeroPad(destination.router, 32),
      messageId,
      nonce: parsed.nonce,
    });

    const { encodedVaa, vaa } = await this.fetchMatchingVaa(
      origin,
      publication,
      log,
    );

    log.info(
      {
        messageId,
        sequence: publication.sequence,
        guardianSetIndex: vaa.guardianSetIndex,
        vaaBytes: ethers.utils.hexDataLength(encodedVaa),
      },
      'Resolved Wormhole VAA',
    );

    // `createAbiHandler` ABI-encodes this single `bytes` return, producing
    // exactly the metadata `WormholeVaaHookIsm.verify` decodes.
    return encodedVaa;
  }

  private async routesFor(
    originDomain: number,
    destinationDomain: number,
    requestRouter: unknown,
    logger: Logger,
  ): Promise<{
    origin: WormholeChainConfig;
    destination: WormholeChainConfig;
  }> {
    try {
      assert(
        typeof requestRouter === 'string' &&
          ethers.utils.isAddress(requestRouter),
        'Invalid Wormhole CCIP sender',
      );
      const originChain = this.multiProvider.tryGetChainName(originDomain);
      const destinationChain =
        this.multiProvider.tryGetChainName(destinationDomain);
      assert(originChain, `Unknown Hyperlane origin domain ${originDomain}`);
      assert(
        destinationChain,
        `Unknown Hyperlane destination domain ${destinationDomain}`,
      );
      assert(
        this.multiProvider.tryGetProvider(originChain) !== null,
        `Hyperlane origin domain ${originDomain} has no configured RPC provider`,
      );
      assert(
        this.multiProvider.tryGetProvider(destinationChain) !== null,
        `Hyperlane destination domain ${destinationDomain} has no configured RPC provider`,
      );
      return await resolveWormholeRoutes(
        originDomain,
        destinationDomain,
        requestRouter,
        (router, domain) =>
          WormholeVaaHookIsm__factory.connect(
            router,
            this.multiProvider.getProvider(domain),
          ),
      );
    } catch (error) {
      const reason =
        error instanceof RpcUnavailableError
          ? UnhandledErrorReason.RPC_UNAVAILABLE
          : UnhandledErrorReason.WORMHOLE_ROUTE_NOT_CONFIGURED;
      PrometheusMetrics.logUnhandledError(this.config.serviceName, reason);
      logger.error(
        {
          originDomain,
          destinationDomain,
          requestRouter,
          error_reason: reason,
          error: error instanceof Error ? error.message : String(error),
        },
        'Unable to resolve Wormhole route',
      );
      throw error;
    }
  }

  /**
   * Queries every endpoint in parallel and returns the first VAA that matches
   * the publication, so one slow endpoint cannot hold up the others. Rounds
   * repeat with backoff only while some endpoint reports the VAA as pending.
   */
  private async fetchMatchingVaa(
    origin: WormholeChainConfig,
    publication: WormholePublication,
    logger: Logger,
  ): Promise<{ encodedVaa: string; vaa: ParsedVaa }> {
    const originRouter = ethers.utils.hexZeroPad(origin.router, 32);
    const vaaId = formatVaaId(
      origin.wormholeChainId,
      originRouter,
      publication.sequence,
    );

    for (let attempt = 0; ; attempt++) {
      let failures: VaaEndpointError[];
      try {
        return await Promise.any(
          this.vaaUrls.map((url) =>
            this.fetchFromEndpoint(url, {
              origin,
              originRouter,
              publication,
              vaaId,
              logger,
            }),
          ),
        );
      } catch (error) {
        assert(
          error instanceof AggregateError,
          `Unexpected VAA lookup failure for ${vaaId}`,
        );
        failures = error.errors.filter(
          (failure): failure is VaaEndpointError =>
            failure instanceof VaaEndpointError,
        );
        assert(
          failures.length === this.vaaUrls.length,
          `Unexpected VAA endpoint failure for ${vaaId}`,
        );
      }

      const pending = failures.find(
        ({ failure }) => failure === VaaEndpointFailure.Pending,
      );
      if (pending && attempt + 1 < this.maxAttempts) {
        await sleep(this.backoffMs(attempt));
        continue;
      }

      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        failures.every(({ failure }) => failure === VaaEndpointFailure.Mismatch)
          ? UnhandledErrorReason.WORMHOLE_VAA_MISMATCH
          : UnhandledErrorReason.WORMHOLE_VAA_UNAVAILABLE,
      );
      if (pending?.reason instanceof VaaPendingError) throw pending.reason;
      throw new Error(
        `No endpoint served a VAA matching ${vaaId}: ${failures
          .map(({ message }) => message)
          .join('; ')}`,
      );
    }
  }

  private async fetchFromEndpoint(
    url: string,
    {
      origin,
      originRouter,
      publication,
      vaaId,
      logger,
    }: {
      origin: WormholeChainConfig;
      originRouter: string;
      publication: WormholePublication;
      vaaId: string;
      logger: Logger;
    },
  ): Promise<{ encodedVaa: string; vaa: ParsedVaa }> {
    let fetched: { encodedVaa: string; vaa: ParsedVaa };
    try {
      fetched = await this.vaaFetcher.fetchVaa(
        url,
        origin.wormholeChainId,
        originRouter,
        publication.sequence,
        logger,
      );
    } catch (error) {
      const failure =
        error instanceof VaaPendingError
          ? VaaEndpointFailure.Pending
          : VaaEndpointFailure.Unavailable;
      const endpointError = new VaaEndpointError(url, failure, error);
      if (failure === VaaEndpointFailure.Unavailable) {
        logger.warn(
          { vaaId, error: endpointError.message },
          'VAA endpoint failed',
        );
      }
      throw endpointError;
    }

    // Never trust the endpoint's own metadata; re-check the decoded VAA.
    try {
      const { vaa } = fetched;
      const servedVaaId = formatVaaId(
        vaa.emitterChainId,
        vaa.emitterAddress,
        vaa.sequence,
      );
      assert(
        servedVaaId === vaaId,
        `Endpoint served VAA ${servedVaaId} instead of ${vaaId}`,
      );
      assertVaaMatchesPublication(vaa, publication, {
        emitterChainId: origin.wormholeChainId,
        originRouter,
      });
      return fetched;
    } catch (error) {
      const endpointError = new VaaEndpointError(
        url,
        VaaEndpointFailure.Mismatch,
        error,
      );
      logger.warn(
        { vaaId, error: endpointError.message },
        'VAA endpoint served a VAA that does not match the publication',
      );
      throw endpointError;
    }
  }

  /** Exponential backoff with jitter, so retries do not synchronize. */
  private backoffMs(attempt: number): number {
    const base = this.baseRetryDelayMs * 2 ** attempt;
    return base + Math.floor(Math.random() * this.baseRetryDelayMs);
  }

  private findPublication(
    logs: ReadonlyArray<{
      address: string;
      topics: Array<string>;
      data: string;
    }>,
    query: Parameters<typeof findMatchingWormholePublication>[1],
  ) {
    try {
      return findMatchingWormholePublication(logs, query);
    } catch (error) {
      const ambiguous =
        error instanceof Error && error.message.includes('Ambiguous');
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        ambiguous
          ? UnhandledErrorReason.WORMHOLE_PUBLICATION_AMBIGUOUS
          : UnhandledErrorReason.WORMHOLE_PUBLICATION_NOT_FOUND,
      );
      throw error;
    }
  }

  private async resolveOriginTxHash(
    originTxHash: string | undefined,
    messageId: string,
    logger: Logger,
  ): Promise<string> {
    if (originTxHash) {
      logger.info({ originTxHash, messageId }, 'Using tx hash from relayer');
      return originTxHash;
    }

    logger.info(
      { messageId },
      'No tx hash from relayer, falling back to Explorer lookup',
    );
    const txHash =
      await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        logger,
      );
    assert(txHash, `Unable to resolve origin transaction for ${messageId}`);
    return txHash;
  }
}
