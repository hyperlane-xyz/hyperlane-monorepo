import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { IWormholeVaaService__factory } from '@hyperlane-xyz/core';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, parseMessage } from '@hyperlane-xyz/utils';

import { createAbiHandler } from '../utils/abiHandler.js';
import {
  PrometheusMetrics,
  UnhandledErrorReason,
} from '../utils/prometheus.js';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';
import { WormholeVaaFetcher } from './WormholeVaaFetcher.js';
import {
  assertVaaMatchesPublication,
  findMatchingWormholePublication,
} from './wormholeVaaMatcher.js';

/**
 * Per-chain Wormhole route data.
 *
 * These are deployment facts, not defaults: the official Core proxy for the
 * environment, that chain's Wormhole chain ID, and the enrolled Hyperlane
 * router. Supplying them explicitly is what lets the service reject a lookalike
 * publication instead of scanning every log in a receipt.
 */
export const WormholeChainConfigSchema = z.object({
  core: z
    .string()
    .refine(ethers.utils.isAddress, 'core must be an address')
    .refine(
      (address) => address !== ethers.constants.AddressZero,
      'core must not be the zero address',
    ),
  wormholeChainId: z.number().int().positive().max(65_535),
  router: z
    .string()
    .refine(ethers.utils.isAddress, 'router must be an address')
    .refine(
      (address) => address !== ethers.constants.AddressZero,
      'router must not be the zero address',
    ),
});

export type WormholeChainConfig = z.infer<typeof WormholeChainConfigSchema>;

export const WormholeRoutesSchema = z.record(
  z.string(),
  WormholeChainConfigSchema,
);

const CommaSeparatedUrls = z
  .string()
  .transform((value) => value.split(',').map((url) => url.trim()))
  .pipe(z.array(z.string().url()).min(1));

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
  /** Comma-separated Wormholescan-compatible base URLs. */
  WORMHOLE_VAA_URLS: CommaSeparatedUrls,
  /** JSON object keyed by chain name; see `WormholeChainConfigSchema`. */
  WORMHOLE_ROUTES: z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'WORMHOLE_ROUTES must be valid JSON',
        });
        return z.NEVER;
      }
    })
    .pipe(WormholeRoutesSchema),
  WORMHOLE_VAA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WORMHOLE_VAA_MAX_BYTES: z.coerce.number().int().positive().default(65_536),
  WORMHOLE_VAA_CACHE_ENTRIES: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  WORMHOLE_VAA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  WORMHOLE_VAA_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000),
});

/** The one `HyperlaneService` capability this service needs. */
export interface OriginTransactionResolver {
  getOriginTransactionHashByMessageId(
    id: string,
    logger: Logger,
  ): Promise<string>;
}

export interface WormholeVaaServiceConfig extends ServiceConfigWithMultiProvider {
  routes: Record<string, WormholeChainConfig>;
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
  public router: Router;

  private readonly multiProvider: MultiProvider;
  private readonly routes: Record<string, WormholeChainConfig>;
  private readonly vaaFetcher: Pick<WormholeVaaFetcher, 'fetchVaa'>;
  private readonly hyperlaneService: OriginTransactionResolver;

  static async create(serviceName: string): Promise<WormholeVaaService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new WormholeVaaService({
      serviceName,
      multiProvider,
      routes: env.WORMHOLE_ROUTES,
      vaaFetcher: new WormholeVaaFetcher(serviceName, {
        urls: env.WORMHOLE_VAA_URLS,
        timeoutMs: env.WORMHOLE_VAA_TIMEOUT_MS,
        maxResponseBytes: env.WORMHOLE_VAA_MAX_BYTES,
        maxCacheEntries: env.WORMHOLE_VAA_CACHE_ENTRIES,
        maxAttempts: env.WORMHOLE_VAA_MAX_ATTEMPTS,
        baseRetryDelayMs: env.WORMHOLE_VAA_RETRY_DELAY_MS,
      }),
      hyperlaneService: new HyperlaneService(
        serviceName,
        env.HYPERLANE_EXPLORER_URL,
      ),
    });
  }

  constructor(config: WormholeVaaServiceConfig) {
    super(config);
    this.multiProvider = config.multiProvider;
    this.routes = config.routes;
    this.vaaFetcher = config.vaaFetcher;
    this.hyperlaneService = config.hyperlaneService;

    this.router = Router();

    // CCIP-read spec: GET /getWormholeVaa/:sender/:callData.json
    this.router.get(
      '/getWormholeVaa/:sender/:callData.json',
      createAbiHandler(
        IWormholeVaaService__factory,
        'getWormholeVaa',
        (message: string, logger: Logger) =>
          this.getWormholeVaa(message, undefined, logger),
      ),
    );

    // CCIP-read spec: POST /getWormholeVaa
    this.router.post('/getWormholeVaa', async (req, res) => {
      const rawTxHash = req.body?.origin_tx_hash;
      const originTxHash =
        typeof rawTxHash === 'string' && ethers.utils.isHexString(rawTxHash, 32)
          ? rawTxHash
          : undefined;
      return createAbiHandler(
        IWormholeVaaService__factory,
        'getWormholeVaa',
        (message: string, logger: Logger) =>
          this.getWormholeVaa(message, originTxHash, logger),
      )(req, res);
    });
  }

  async getWormholeVaa(
    message: string,
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

    const origin = this.routeFor(parsed.origin, log);
    const destination = this.routeFor(parsed.destination, log);

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
      originDomain: parsed.origin,
      destinationDomain: parsed.destination,
      nonce: parsed.nonce,
    });

    const { encodedVaa, vaa } = await this.vaaFetcher.fetchVaa(
      origin.wormholeChainId,
      ethers.utils.hexZeroPad(origin.router, 32),
      publication.sequence,
      log,
    );

    // Never trust the endpoint's own metadata; re-check the decoded VAA.
    try {
      assertVaaMatchesPublication(vaa, publication, {
        emitterChainId: origin.wormholeChainId,
        originRouter: ethers.utils.hexZeroPad(origin.router, 32),
      });
    } catch (error) {
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.WORMHOLE_VAA_MISMATCH,
      );
      throw error;
    }

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

  private routeFor(domain: number, logger: Logger): WormholeChainConfig {
    const chainName = this.multiProvider.tryGetChainName(domain);
    const route = chainName ? this.routes[chainName] : undefined;
    if (!route) {
      PrometheusMetrics.logUnhandledError(
        this.config.serviceName,
        UnhandledErrorReason.WORMHOLE_ROUTE_NOT_CONFIGURED,
      );
      logger.error({ domain, chainName }, 'No Wormhole route configured');
      throw new Error(`No Wormhole route configured for domain ${domain}`);
    }
    return route;
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
