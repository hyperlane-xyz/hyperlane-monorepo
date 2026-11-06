import type { Logger } from 'pino';

import { ethers, type providers } from 'ethers';

import {
  DomainRoutingIsm__factory,
  IInterchainSecurityModule__factory,
  MailboxClient__factory,
  Mailbox__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import {
  type DerivedIsmConfig,
  EvmIsmReader,
  type IsmConfig,
  IsmType,
  ModuleType,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { readBlacklistedIds } from '@hyperlane-xyz/sdk/ism/blacklist';
import {
  isMissingSelectorCallException,
  isRevertData,
} from '@hyperlane-xyz/sdk/utils/contract';
import { assert, concurrentMap, ProtocolType } from '@hyperlane-xyz/utils';

import { PendingTransferMiddlewareType } from '../../config/types.js';
import type {
  ExplorerMessage,
  IExplorerClient,
} from '../../utils/ExplorerClient.js';

import { PendingTransferMiddleware } from './PendingTransferMiddleware.js';
import { normalizeMessageId } from './types.js';

const REFRESH_CONCURRENCY = 3;

export const BLACKLIST_ISM_REFRESH_FAILED_MESSAGE =
  'BlacklistIsm refresh failed, keeping last known blacklisted ids';

/**
 * The ISM rejects every message from the origin, because a routing ISM it
 * needs has no module for it.
 */
interface UnroutedOrigin {
  readonly unroutedRoutingIsm: string | undefined;
}

/**
 * BlacklistIsms, by lowercase address, that make an ISM reject a message on
 * their own, with their blacklisted ids from the derivation.
 */
type SufficientBlacklists = Map<string, readonly string[]>;

type ResolvedBlacklists = SufficientBlacklists | UnroutedOrigin;

/**
 * The BlacklistIsms that reject one (origin, destination) pair's messages on
 * their own, and the union of their last known blacklisted ids.
 */
interface RouteBlacklist {
  readonly destination: number;
  readonly chainName: string;
  readonly blacklistIsms: readonly string[];
  readonly ids: Set<string>;
  loadedAt: number;
  lastAttemptAt: number;
}

/** One BlacklistIsm read on a destination, shared by the pairs using it. */
interface BlacklistRead {
  readonly destination: number;
  readonly chainName: string;
  readonly blacklistIsm: string;
  readonly routes: RouteBlacklist[];
}

export interface BlacklistIsmMiddlewareOptions {
  refreshIntervalMs: number;
  routersByDomain: Record<number, string>;
  mailboxByDomain: Record<number, string>;
  multiProvider: MultiProvider;
}

function addressOf(config: IsmConfig): string | undefined {
  if (typeof config === 'string') return config;

  return 'address' in config && typeof config.address === 'string'
    ? config.address
    : undefined;
}

/**
 * The ISMs on `origin`'s path through `config` that defer to their mailbox's
 * default ISM: mailbox default ISM wrappers, and fallback routing ISMs without
 * a module for the origin.
 */
function defaultingIsms(config: IsmConfig, origin: string): string[] {
  if (typeof config === 'string') return [];

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return config.modules.flatMap((module) => defaultingIsms(module, origin));
    case IsmType.FALLBACK_ROUTING:
    case IsmType.MAILBOX_DEFAULT: {
      if ('domains' in config && origin in config.domains) {
        return defaultingIsms(config.domains[origin], origin);
      }

      const address = addressOf(config);
      assert(address, `Derived ${config.type} config has no address`);
      return [address];
    }
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return origin in config.domains
        ? defaultingIsms(config.domains[origin], origin)
        : [];
    default:
      return [];
  }
}

/**
 * Combines an aggregation's children: copies of one BlacklistIsm reject
 * together, so children are counted by address, and children that always
 * reject count against the threshold.
 */
function combineAggregation(
  children: readonly ResolvedBlacklists[],
  threshold: number,
): ResolvedBlacklists {
  const resolved: SufficientBlacklists[] = [];
  let alwaysRejecting: UnroutedOrigin | undefined;
  for (const child of children) {
    if (child instanceof Map) resolved.push(child);
    else alwaysRejecting ??= child;
  }

  const passable = resolved.length;
  if (alwaysRejecting && passable < threshold) return alwaysRejecting;

  const sufficient: SufficientBlacklists = new Map();
  for (const child of resolved) {
    for (const [address, ids] of child) {
      const rejecting = resolved.filter((other) => other.has(address));
      if (passable - rejecting.length < threshold) {
        sufficient.set(address, ids);
      }
    }
  }

  return sufficient;
}

/**
 * Finds the BlacklistIsms that make `config` reject a message from `origin`
 * on their own: with only that BlacklistIsm rejecting and every other module
 * passing, the ISM still rejects. Domain routing ISMs are resolved for the
 * origin; a fallback routing ISM without a module for it and a mailbox
 * default ISM wrapper use their entry in `mailboxDefaults`, the already
 * resolved default ISM of their own mailbox, keyed by their lowercase address.
 * A routing ISM without a module for the origin always rejects.
 * Any other ISM never blocks, including amount routing ISMs, whose module
 * depends on the transfer amount.
 */
function findSufficientBlacklists(
  config: IsmConfig,
  origin: string,
  mailboxDefaults: ReadonlyMap<string, ResolvedBlacklists>,
): ResolvedBlacklists {
  if (typeof config === 'string') return new Map();

  switch (config.type) {
    case IsmType.BLACKLIST: {
      const address = addressOf(config);
      assert(address, 'Derived BlacklistIsm config has no address');

      return new Map([[address.toLowerCase(), config.blacklistedIds]]);
    }
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return combineAggregation(
        config.modules.map((module) =>
          findSufficientBlacklists(module, origin, mailboxDefaults),
        ),
        config.threshold,
      );
    case IsmType.ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      if (!(origin in config.domains)) {
        return { unroutedRoutingIsm: addressOf(config) };
      }

      return findSufficientBlacklists(
        config.domains[origin],
        origin,
        mailboxDefaults,
      );
    case IsmType.FALLBACK_ROUTING:
      if (origin in config.domains) {
        return findSufficientBlacklists(
          config.domains[origin],
          origin,
          mailboxDefaults,
        );
      }

      return mailboxDefaultFor(config, mailboxDefaults);
    case IsmType.MAILBOX_DEFAULT:
      // DefaultIsm routes every message to its mailbox's default ISM.
      return mailboxDefaultFor(config, mailboxDefaults);
    default:
      return new Map();
  }
}

function mailboxDefaultFor(
  config: Exclude<IsmConfig, string>,
  mailboxDefaults: ReadonlyMap<string, ResolvedBlacklists>,
): ResolvedBlacklists {
  const address = addressOf(config);
  assert(address, `Derived ${config.type} config has no address`);

  const resolved = mailboxDefaults.get(address.toLowerCase());
  assert(
    resolved,
    `ISM ${address} defers to a mailbox default ISM that was not resolved`,
  );

  return resolved;
}

function routeKey(origin: number, destination: number): string {
  return `${origin}:${destination}`;
}

function deriveIsmConfig(
  multiProvider: MultiProvider,
  destination: number,
  ismAddress: string,
): Promise<DerivedIsmConfig> {
  return new EvmIsmReader(
    multiProvider,
    multiProvider.getChainName(destination),
  ).deriveIsmConfigFromAddress(ismAddress);
}

const errorStringInterface = new ethers.utils.Interface([
  'function Error(string)',
]);

/** The revert data of `DomainRoutingIsm.module(origin)` for an unset origin. */
function missingOriginRevertData(origin: number): string {
  return errorStringInterface.encodeFunctionData('Error', [
    `No ISM found for origin: ${origin}`,
  ]);
}

function memoize<T>(
  cache: Map<string, Promise<T>>,
  address: string,
  read: () => Promise<T>,
): Promise<T> {
  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = read();
  cache.set(key, pending);
  return pending;
}

/**
 * Resolves the default ISMs of a destination's mailboxes one origin at a time,
 * reading only the branch that origin's messages use: domain routing ISMs are
 * followed through `module(origin)`, aggregations through their modules, and
 * only NULL-type ISMs, the only ones that can be a BlacklistIsm, are derived.
 * Other ISMs, including routing ISMs without `module(origin)`, never block and
 * are not read further. Reads shared by several origins or mailboxes are made
 * once.
 */
class MailboxDefaultIsmReader {
  private readonly provider: providers.Provider;
  private readonly defaultIsms = new Map<string, Promise<string>>();
  private readonly mailboxes = new Map<string, Promise<string>>();
  private readonly resolved = new Map<string, Promise<ResolvedBlacklists>>();
  private readonly moduleTypes = new Map<string, Promise<number>>();
  private readonly aggregations = new Map<
    string,
    Promise<[string[], number]>
  >();
  private readonly derived = new Map<string, Promise<DerivedIsmConfig>>();

  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly destination: number,
  ) {
    this.provider = multiProvider.getProvider(destination);
  }

  defaultIsm(mailbox: string): Promise<string> {
    return memoize(this.defaultIsms, mailbox, () =>
      Mailbox__factory.connect(mailbox, this.provider).defaultIsm(),
    );
  }

  /** The mailbox a mailbox default ISM wrapper or a mailbox client uses. */
  mailboxOf(ism: string): Promise<string> {
    return memoize(this.mailboxes, ism, () =>
      MailboxClient__factory.connect(ism, this.provider).mailbox(),
    );
  }

  resolve(
    mailbox: string,
    origin: number,
    originName: string,
  ): Promise<ResolvedBlacklists> {
    return memoize(this.resolved, `${mailbox}:${origin}`, async () =>
      this.resolveIsm(
        await this.defaultIsm(mailbox),
        origin,
        originName,
        new Set(),
      ),
    );
  }

  private async resolveIsm(
    address: string,
    origin: number,
    originName: string,
    visited: ReadonlySet<string>,
  ): Promise<ResolvedBlacklists> {
    const key = address.toLowerCase();
    assert(
      !visited.has(key),
      `Mailbox default ISM ${address} loops back to itself for ${originName}`,
    );
    const path = new Set(visited).add(key);

    const moduleType = await memoize(this.moduleTypes, address, () =>
      IInterchainSecurityModule__factory.connect(
        address,
        this.provider,
      ).moduleType(),
    );

    switch (moduleType) {
      case ModuleType.ROUTING: {
        let routed: string;
        try {
          routed = await DomainRoutingIsm__factory.connect(
            address,
            this.provider,
          ).module(origin);
        } catch (error: unknown) {
          if (isRevertData(error, missingOriginRevertData(origin))) {
            return { unroutedRoutingIsm: address };
          }
          if (!isMissingSelectorCallException(error)) throw error;

          return new Map();
        }

        return this.resolveIsm(routed, origin, originName, path);
      }
      case ModuleType.AGGREGATION: {
        const [modules, threshold] = await memoize(
          this.aggregations,
          address,
          () =>
            StaticAggregationIsm__factory.connect(
              address,
              this.provider,
            ).modulesAndThreshold('0x'),
        );

        const children: ResolvedBlacklists[] = [];
        for (const module of modules) {
          children.push(
            await this.resolveIsm(module, origin, originName, path),
          );
        }

        return combineAggregation(children, threshold);
      }
      case ModuleType.NULL:
        return findSufficientBlacklists(
          await this.derive(address),
          originName,
          new Map(),
        );
      default:
        return new Map();
    }
  }

  private derive(address: string): Promise<DerivedIsmConfig> {
    return memoize(this.derived, address, () =>
      deriveIsmConfig(this.multiProvider, this.destination, address),
    );
  }
}

/**
 * Reads the destination router's ISM and finds its sufficient BlacklistIsms
 * for every origin. A custom router ISM is derived in full once; the mailbox
 * default ISM, used by routers without one and reached through mailbox default
 * ISM wrappers or fallback routing ISMs, is resolved per origin.
 */
async function readRecipientIsmBlacklists(
  options: BlacklistIsmMiddlewareOptions,
  destination: number,
  router: string,
  origins: number[],
): Promise<Array<[number, ResolvedBlacklists]>> {
  const { multiProvider } = options;
  const mailboxAddress = options.mailboxByDomain[destination];
  assert(
    mailboxAddress,
    `Missing mailbox for destination domain ${destination}`,
  );

  const defaultIsmReader = new MailboxDefaultIsmReader(
    multiProvider,
    destination,
  );
  // Mailbox.recipientIsm falls back to the default ISM when the router's
  // ISM is unset, exactly as delivery does.
  const [recipientIsm, defaultIsm] = await Promise.all([
    Mailbox__factory.connect(
      mailboxAddress,
      multiProvider.getProvider(destination),
    ).recipientIsm(router),
    defaultIsmReader.defaultIsm(mailboxAddress),
  ]);
  const usesDefault = recipientIsm.toLowerCase() === defaultIsm.toLowerCase();
  const customConfig = usesDefault
    ? undefined
    : await deriveIsmConfig(multiProvider, destination, recipientIsm);

  const resolved: Array<[number, ResolvedBlacklists]> = [];
  for (const origin of origins) {
    const originName = multiProvider.getChainName(origin);
    if (!customConfig) {
      resolved.push([
        origin,
        await defaultIsmReader.resolve(mailboxAddress, origin, originName),
      ]);
      continue;
    }

    // Each wrapper or fallback routing ISM defers to its own mailbox.
    const mailboxDefaults = new Map<string, ResolvedBlacklists>();
    for (const ism of defaultingIsms(customConfig, originName)) {
      const ismMailbox = await defaultIsmReader.mailboxOf(ism);
      mailboxDefaults.set(
        ism.toLowerCase(),
        await defaultIsmReader.resolve(ismMailbox, origin, originName),
      );
    }

    resolved.push([
      origin,
      findSufficientBlacklists(customConfig, originName, mailboxDefaults),
    ]);
  }

  return resolved;
}

/**
 * Resolves every (origin, destination) pair with an EVM destination to the
 * BlacklistIsms that reject its messages on their own, seeded with the ids
 * read during derivation.
 */
async function resolveRouteBlacklists(
  options: BlacklistIsmMiddlewareOptions,
  logger: Logger,
): Promise<Map<string, RouteBlacklist>> {
  const { multiProvider } = options;
  const domains = Object.keys(options.routersByDomain).map(Number);
  const routes = new Map<string, RouteBlacklist>();

  for (const destination of domains) {
    if (multiProvider.getProtocol(destination) !== ProtocolType.Ethereum) {
      logger.debug(
        { destination },
        'Skipping BlacklistIsm resolution for non-EVM destination',
      );
      continue;
    }

    const router = options.routersByDomain[destination];
    const origins = domains.filter((origin) => origin !== destination);

    let resolved: Array<[number, ResolvedBlacklists]>;
    try {
      resolved = await readRecipientIsmBlacklists(
        options,
        destination,
        router,
        origins,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to resolve the ISM of router ${router} on domain ${destination}: ${message}`,
      );
    }

    for (const [origin, sufficient] of resolved) {
      if (!(sufficient instanceof Map)) {
        logger.warn(
          {
            router,
            destination,
            origin,
            routingIsm: sufficient.unroutedRoutingIsm,
          },
          'Routing ISM has no module for origin, skipping BlacklistIsm check for this route pair',
        );
        continue;
      }

      if (sufficient.size === 0) {
        logger.debug(
          { origin, destination, router },
          'No BlacklistIsm can block messages on this route pair, skipping',
        );
        continue;
      }

      const now = Date.now();
      const route: RouteBlacklist = {
        destination,
        chainName: multiProvider.getChainName(destination),
        blacklistIsms: [...sufficient.keys()],
        ids: new Set(
          [...sufficient.values()].flat().map((id) => id.toLowerCase()),
        ),
        loadedAt: now,
        lastAttemptAt: now,
      };
      routes.set(routeKey(origin, destination), route);
      logger.info(
        { origin, destination, router, blacklistIsms: route.blacklistIsms },
        'Resolved BlacklistIsms for pending transfer middleware',
      );
    }
  }

  return routes;
}

/**
 * Ignores messages to EVM destinations that a BlacklistIsm in the destination
 * router's ISM rejects on its own: with that BlacklistIsm rejecting and every
 * other module passing, the ISM still rejects the message. ISMs that only
 * reject when several BlacklistIsms reject together are treated as never
 * blocking, so those transfers stay reserved.
 *
 * `create()` resolves each destination router's ISM for every origin of the
 * route and keeps, per (origin, destination) pair, only those BlacklistIsms
 * and the union of their blacklisted ids. A custom router ISM is derived in
 * full once with `EvmIsmReader`; the mailbox default ISM, which routers
 * without one use and which mailbox default ISM wrappers and fallback routing
 * ISMs defer to through their own mailbox, is read only along each origin's
 * branch, deriving only the ISMs that can be a BlacklistIsm. ISMs are never re-read, so restart the
 * rebalancer after changing a router's ISM, the mailbox default ISM or a
 * routing ISM. Amount routing ISMs are treated as never blocking, since their
 * module depends on the transfer amount.
 *
 * A pair's ids are re-read only when one of its messages is queried and
 * `refreshIntervalMs` has passed since its last attempt; each BlacklistIsm is
 * read once per refresh however many pairs use it. BlacklistIsms are
 * append-only, so new ids are added to the pair's set; a failed read keeps the
 * last known ids, which can only miss ids added since, never over-ignore.
 */
export class BlacklistIsmMiddleware extends PendingTransferMiddleware {
  private constructor(
    inner: IExplorerClient,
    private readonly options: BlacklistIsmMiddlewareOptions,
    /** Pairs with at least one BlacklistIsm that rejects on its own. */
    private readonly routes: ReadonlyMap<string, RouteBlacklist>,
  ) {
    super(inner, PendingTransferMiddlewareType.BlacklistIsm);
  }

  /**
   * Resolves the BlacklistIsms of every route pair. Throws if any EVM
   * destination's ISM cannot be derived or if no route pair has a BlacklistIsm
   * that can block a message. A pair whose domain routing ISM has no module
   * for the origin is skipped with a warning.
   */
  static async create(
    inner: IExplorerClient,
    options: BlacklistIsmMiddlewareOptions,
    logger: Logger,
  ): Promise<BlacklistIsmMiddleware> {
    const routes = await resolveRouteBlacklists(options, logger);
    if (routes.size === 0) {
      throw new Error(
        'No route pair has a BlacklistIsm that can block a message; remove the blacklistIsm pending transfer middleware',
      );
    }

    return new BlacklistIsmMiddleware(inner, options, routes);
  }

  protected async findIgnored(
    messages: ExplorerMessage[],
    logger: Logger,
  ): Promise<Map<string, string>> {
    await this.refreshStaleRoutes(messages, logger);

    const ignored = new Map<string, string>();
    for (const msg of messages) {
      const destination = msg.destination_domain_id;
      const route = this.routes.get(
        routeKey(msg.origin_domain_id, destination),
      );
      const messageId = normalizeMessageId(msg.msg_id);
      if (!route?.ids.has(messageId)) continue;

      ignored.set(
        messageId,
        `Blacklisted by a BlacklistIsm (${route.blacklistIsms.join(', ')}) in the ISM of router ${this.options.routersByDomain[destination]} on domain ${destination}`,
      );
    }

    return ignored;
  }

  /**
   * Re-reads the BlacklistIsms of the stale pairs that have a message in this
   * batch, reading each BlacklistIsm once. A failed read is logged once, with
   * the cache age of the oldest pair it leaves stale.
   */
  private async refreshStaleRoutes(
    messages: ExplorerMessage[],
    logger: Logger,
  ): Promise<void> {
    const now = Date.now();
    const stale = new Set<RouteBlacklist>();
    for (const msg of messages) {
      const route = this.routes.get(
        routeKey(msg.origin_domain_id, msg.destination_domain_id),
      );
      if (
        route &&
        now - route.lastAttemptAt >= this.options.refreshIntervalMs
      ) {
        stale.add(route);
      }
    }
    if (stale.size === 0) return;

    const reads = new Map<string, BlacklistRead>();
    for (const route of stale) {
      route.lastAttemptAt = now;
      for (const blacklistIsm of route.blacklistIsms) {
        const key = `${route.destination}:${blacklistIsm}`;
        const read = reads.get(key) ?? {
          destination: route.destination,
          chainName: route.chainName,
          blacklistIsm,
          routes: [],
        };
        read.routes.push(route);
        reads.set(key, read);
      }
    }

    const failed = new Set<RouteBlacklist>();
    await concurrentMap(
      REFRESH_CONCURRENCY,
      [...reads.values()],
      async (read) => {
        try {
          const ids = await readBlacklistedIds(
            read.chainName,
            read.blacklistIsm,
            this.options.multiProvider,
          );

          for (const route of read.routes) {
            for (const id of ids) route.ids.add(id.toLowerCase());
          }
        } catch (error: unknown) {
          read.routes.forEach((route) => failed.add(route));
          const oldestLoadedAt = Math.min(
            ...read.routes.map((route) => route.loadedAt),
          );
          logger.warn(
            {
              blacklistIsm: read.blacklistIsm,
              destination: read.destination,
              cachedAgeSecs: Math.floor((now - oldestLoadedAt) / 1000),
              error: error instanceof Error ? error.message : String(error),
            },
            BLACKLIST_ISM_REFRESH_FAILED_MESSAGE,
          );
        }
      },
    );

    for (const route of stale) {
      if (!failed.has(route)) route.loadedAt = now;
    }
  }
}
