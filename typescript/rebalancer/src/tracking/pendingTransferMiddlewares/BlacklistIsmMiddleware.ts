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
  EthJsonRpcBlockParameterTag,
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
import {
  assert,
  concurrentMap,
  LogLevel,
  ProtocolType,
} from '@hyperlane-xyz/utils';

import { PendingTransferMiddlewareType } from '../../config/types.js';
import type {
  ExplorerMessage,
  IExplorerClient,
} from '../../utils/ExplorerClient.js';

import { PendingTransferMiddleware } from './PendingTransferMiddleware.js';
import { normalizeMessageId } from './types.js';

const REFRESH_CONCURRENCY = 3;

export const BLACKLIST_ISM_REFRESH_FAILED_MESSAGE =
  "BlacklistIsm refresh failed, keeping the destination's last known BlacklistIsms and ids";

export const BLACKLIST_ISM_NO_BLOCKING_ROUTES_MESSAGE =
  'No route pair has a BlacklistIsm that can block a message after refresh, ignoring no pending transfers';

/**
 * The ISM rejects every message from the origin, because a routing ISM it
 * needs has no module for it.
 */
interface UnroutedOrigin {
  readonly unroutedRoutingIsm: string | undefined;
}

/**
 * BlacklistIsms, by lowercase address, that make an ISM reject a message on
 * their own.
 */
type SufficientBlacklists = Set<string>;

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
    if (child instanceof Set) resolved.push(child);
    else alwaysRejecting ??= child;
  }

  const passable = resolved.length;
  if (alwaysRejecting && passable < threshold) return alwaysRejecting;

  const sufficient: SufficientBlacklists = new Set();
  for (const child of resolved) {
    for (const address of child) {
      const rejecting = resolved.filter((other) => other.has(address));
      if (passable - rejecting.length < threshold) {
        sufficient.add(address);
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
  if (typeof config === 'string') return new Set();

  switch (config.type) {
    case IsmType.BLACKLIST: {
      const address = addressOf(config);
      assert(address, 'Derived BlacklistIsm config has no address');

      return new Set([address.toLowerCase()]);
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
      return new Set();
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

          return new Set();
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
        return new Set();
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
 * Resolves the pairs with one EVM destination to the BlacklistIsms that reject
 * their messages on their own and reads their ids at the finalized block.
 */
async function resolveDestinationRoutes(
  options: BlacklistIsmMiddlewareOptions,
  destination: number,
  logger: Logger,
  resolvedLevel: LogLevel.Info | LogLevel.Debug,
): Promise<Map<string, RouteBlacklist>> {
  const { multiProvider } = options;
  const router = options.routersByDomain[destination];
  const origins = Object.keys(options.routersByDomain)
    .map(Number)
    .filter((origin) => origin !== destination);
  const routes = new Map<string, RouteBlacklist>();

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
    if (!(sufficient instanceof Set)) {
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

    const route: RouteBlacklist = {
      destination,
      chainName: multiProvider.getChainName(destination),
      blacklistIsms: [...sufficient],
      ids: new Set(),
    };
    routes.set(routeKey(origin, destination), route);
    logger[resolvedLevel](
      { origin, destination, router, blacklistIsms: route.blacklistIsms },
      'Resolved BlacklistIsms for pending transfer middleware',
    );
  }

  await seedRouteIds(routes, multiProvider);
  return routes;
}

/**
 * Resolves every pair with an EVM destination and reads its ids. With no
 * `previous` routes, at startup, any destination's failure throws; on refresh,
 * a destination that fails keeps its `previous` routes and ids.
 */
async function resolveRouteBlacklists(
  options: BlacklistIsmMiddlewareOptions,
  logger: Logger,
  previous?: ReadonlyMap<string, RouteBlacklist>,
): Promise<Map<string, RouteBlacklist>> {
  const routes = new Map<string, RouteBlacklist>();

  for (const destination of Object.keys(options.routersByDomain).map(Number)) {
    if (
      options.multiProvider.getProtocol(destination) !== ProtocolType.Ethereum
    ) {
      logger.debug(
        { destination },
        'Skipping BlacklistIsm resolution for non-EVM destination',
      );
      continue;
    }

    let resolved: Iterable<[string, RouteBlacklist]>;
    try {
      resolved = await resolveDestinationRoutes(
        options,
        destination,
        logger,
        previous ? LogLevel.Debug : LogLevel.Info,
      );
    } catch (error: unknown) {
      if (!previous) throw error;

      logger.warn(
        {
          destination,
          error: error instanceof Error ? error.message : String(error),
        },
        BLACKLIST_ISM_REFRESH_FAILED_MESSAGE,
      );
      resolved = [...previous].filter(
        ([, route]) => route.destination === destination,
      );
    }

    for (const [key, route] of resolved) routes.set(key, route);
  }

  return routes;
}

function readKey(destination: number, blacklistIsm: string): string {
  return `${destination}:${blacklistIsm}`;
}

/** Groups the BlacklistIsm reads of `routes`, one per destination and ISM. */
function groupReads(routes: Iterable<RouteBlacklist>): BlacklistRead[] {
  const reads = new Map<string, BlacklistRead>();
  for (const route of routes) {
    for (const blacklistIsm of route.blacklistIsms) {
      const key = readKey(route.destination, blacklistIsm);
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

  return [...reads.values()];
}

/** Adds `ids` to every pair using the BlacklistIsm. */
function addIds(read: BlacklistRead, ids: readonly string[]): void {
  for (const route of read.routes) {
    for (const id of ids) route.ids.add(id.toLowerCase());
  }
}

/** Reads a BlacklistIsm's blacklisted ids at its destination's finalized block. */
function readFinalizedIds(
  multiProvider: MultiProvider,
  read: BlacklistRead,
): Promise<string[]> {
  return readBlacklistedIds(
    read.chainName,
    read.blacklistIsm,
    multiProvider,
    undefined,
    EthJsonRpcBlockParameterTag.Finalized,
  );
}

/**
 * Reads every pair's BlacklistIsms at their destination's finalized block and
 * adds the ids to the pairs. Throws if any read fails.
 */
async function seedRouteIds(
  routes: ReadonlyMap<string, RouteBlacklist>,
  multiProvider: MultiProvider,
): Promise<void> {
  await concurrentMap(
    REFRESH_CONCURRENCY,
    groupReads(routes.values()),
    async (read) => {
      let ids: string[];
      try {
        ids = await readFinalizedIds(multiProvider, read);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to read the blacklisted ids of BlacklistIsm ${read.blacklistIsm} on domain ${read.destination}: ${message}`,
          { cause: error },
        );
      }

      addIds(read, ids);
    },
  );
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
 * full with `EvmIsmReader`; the mailbox default ISM, which routers without one
 * use and which mailbox default ISM wrappers and fallback routing ISMs defer
 * to through their own mailbox, is read only along each origin's branch,
 * deriving only the ISMs that can be a BlacklistIsm. Amount routing ISMs are
 * treated as never blocking, since their module depends on the transfer
 * amount.
 *
 * Once `refreshIntervalMs` has passed since the last attempt, the next query
 * repeats this resolution and replaces the pairs, so a changed router ISM,
 * mailbox default ISM or routing ISM takes effect without a restart. The ISM
 * graph is resolved at the latest block. Each destination is refreshed on its
 * own: one whose resolution or id read fails keeps its previous pairs and ids,
 * and a refresh that finds no pair that can block ignores nothing.
 *
 * Blacklisted ids are read at the destination's finalized block, once per
 * BlacklistIsm however many pairs use it, so an id whose blacklisting is
 * reorged out is never ignored and a new blacklist entry takes effect once it
 * is finalized; the ids derived with the graph are not used. An RPC without
 * `finalized` block tag support makes every read on its destination fail,
 * whether the BlacklistIsm enumerates its ids or they are replayed from its
 * logs.
 */
export class BlacklistIsmMiddleware extends PendingTransferMiddleware {
  private lastAttemptAt = Date.now();

  private constructor(
    inner: IExplorerClient,
    private readonly options: BlacklistIsmMiddlewareOptions,
    /** Pairs with at least one BlacklistIsm that rejects on its own. */
    private routes: ReadonlyMap<string, RouteBlacklist>,
  ) {
    super(inner, PendingTransferMiddlewareType.BlacklistIsm);
  }

  /**
   * Resolves the BlacklistIsms of every route pair and reads their ids at the
   * destination's finalized block. Throws if any EVM destination's ISM cannot
   * be derived, if no route pair has a BlacklistIsm that can block a message,
   * or if a BlacklistIsm's ids cannot be read at the finalized block, which
   * includes a destination RPC without `finalized` block tag support. A pair
   * whose domain routing ISM has no module for the origin is skipped with a
   * warning. Later refreshes repeat this per destination but never throw.
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
    await this.refreshIfStale(logger);

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

  private async refreshIfStale(logger: Logger): Promise<void> {
    const now = Date.now();
    if (now - this.lastAttemptAt < this.options.refreshIntervalMs) return;

    this.lastAttemptAt = now;
    this.routes = await resolveRouteBlacklists(
      this.options,
      logger,
      this.routes,
    );
    if (this.routes.size === 0) {
      logger.warn(BLACKLIST_ISM_NO_BLOCKING_ROUTES_MESSAGE);
    }
  }
}
