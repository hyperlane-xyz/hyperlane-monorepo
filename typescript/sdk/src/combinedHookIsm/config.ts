import { Address, assert } from '@hyperlane-xyz/utils';

import { HookConfig, HookType } from '../hook/types.js';
import { collectHookTreeNodes, mapHookTreeNodes } from '../hook/utils.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { ChainMap, ChainName } from '../types.js';
import { collectIsmTreeNodes, mapIsmTreeNodes } from '../utils/ism.js';

export interface CombinedHookIsmWarpChainConfig {
  hook?: HookConfig;
  interchainSecurityModule?: IsmConfig;
  mailbox?: Address;
}

/**
 * Identifies the hook and ISM leaves of one combined hook/ISM protocol, whose
 * paired leaves are installed as the same router on each chain.
 */
export interface CombinedHookIsmLeafMatcher<
  THook extends HookConfig,
  TIsm extends IsmConfig,
> {
  label: string;
  isHook: (config: HookConfig | undefined) => config is THook;
  isIsm: (config: IsmConfig) => config is TIsm;
}

export interface CombinedHookIsmConfigPair<
  THook extends HookConfig,
  TIsm extends IsmConfig,
> {
  hook: THook;
  ism: TIsm;
}

export type MaterializedCombinedHookIsmWarpChainConfig<
  T extends CombinedHookIsmWarpChainConfig,
> = T & {
  hook: HookConfig;
  interchainSecurityModule: IsmConfig;
};

/** Collects concrete addresses from a derived hook tree. */
export function collectHookAddresses(
  config: HookConfig | undefined,
): Address[] {
  if (!config) return [];
  if (typeof config === 'string') return [config];
  const ownAddress =
    'address' in config && typeof config.address === 'string'
      ? [config.address]
      : [];
  switch (config.type) {
    case HookType.AGGREGATION:
      return [...ownAddress, ...config.hooks.flatMap(collectHookAddresses)];
    case HookType.ROUTING:
      return [
        ...ownAddress,
        ...Object.values(config.domains).flatMap(collectHookAddresses),
      ];
    case HookType.FALLBACK_ROUTING:
      return [
        ...ownAddress,
        ...Object.values(config.domains).flatMap(collectHookAddresses),
        ...collectHookAddresses(config.fallback),
      ];
    case HookType.AMOUNT_ROUTING:
      return [
        ...ownAddress,
        ...collectHookAddresses(config.lowerHook),
        ...collectHookAddresses(config.upperHook),
      ];
    case HookType.ARB_L2_TO_L1:
      return [...ownAddress, ...collectHookAddresses(config.childHook)];
    default:
      return ownAddress;
  }
}

/** Collects concrete addresses from a derived ISM tree. */
export function collectIsmAddresses(config: IsmConfig | undefined): Address[] {
  if (!config) return [];
  if (typeof config === 'string') return [config];
  const ownAddress =
    'address' in config && typeof config.address === 'string'
      ? [config.address]
      : [];
  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return [...ownAddress, ...config.modules.flatMap(collectIsmAddresses)];
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return [
        ...ownAddress,
        ...Object.values(config.domains).flatMap(collectIsmAddresses),
      ];
    case IsmType.AMOUNT_ROUTING:
      return [
        ...ownAddress,
        ...collectIsmAddresses(config.lowerIsm),
        ...collectIsmAddresses(config.upperIsm),
      ];
    default:
      return ownAddress;
  }
}

/**
 * Finds and validates the one combined hook/ISM resource the matcher selects
 * in the hook and ISM trees of every chain. A route without any of its leaves
 * returns an empty map.
 */
export function pairCombinedHookIsmConfigs<
  THook extends HookConfig,
  TIsm extends IsmConfig,
>(
  matcher: CombinedHookIsmLeafMatcher<THook, TIsm>,
  configs: ChainMap<CombinedHookIsmWarpChainConfig>,
): ChainMap<CombinedHookIsmConfigPair<THook, TIsm>> {
  const pairs: ChainMap<CombinedHookIsmConfigPair<THook, TIsm>> = {};
  const hasAny = Object.values(configs).some(
    (config) =>
      collectHookTreeNodes(config.hook, matcher.isHook).length > 0 ||
      collectIsmTreeNodes(config.interchainSecurityModule, matcher.isIsm)
        .length > 0,
  );
  if (!hasAny) return pairs;

  for (const [chain, config] of Object.entries(configs)) {
    const hooks = collectHookTreeNodes(config.hook, matcher.isHook);
    const isms = collectIsmTreeNodes(
      config.interchainSecurityModule,
      matcher.isIsm,
    );
    assert(
      hooks.length === 1,
      `${chain} must contain exactly one ${matcher.label} hook leaf; found ${hooks.length}`,
    );
    assert(
      isms.length === 1,
      `${chain} must contain exactly one ${matcher.label} ISM leaf; found ${isms.length}`,
    );
    pairs[chain] = { hook: hooks[0], ism: isms[0] };
  }

  validateDirectionalPairing(matcher, configs);
  return pairs;
}

function hookUsesLeafFor<THook extends HookConfig, TIsm extends IsmConfig>(
  matcher: CombinedHookIsmLeafMatcher<THook, TIsm>,
  config: HookConfig | undefined,
  destination: ChainName,
): boolean {
  if (!config || typeof config === 'string') return false;
  if (matcher.isHook(config)) return true;

  switch (config.type) {
    case HookType.AGGREGATION:
      return config.hooks.some((hook) =>
        hookUsesLeafFor(matcher, hook, destination),
      );
    case HookType.ROUTING:
      return hookUsesLeafFor(matcher, config.domains[destination], destination);
    case HookType.FALLBACK_ROUTING:
      return hookUsesLeafFor(
        matcher,
        config.domains[destination] ?? config.fallback,
        destination,
      );
    case HookType.AMOUNT_ROUTING: {
      const lower = hookUsesLeafFor(matcher, config.lowerHook, destination);
      const upper = hookUsesLeafFor(matcher, config.upperHook, destination);
      assert(
        lower === upper,
        `${matcher.label} cannot be conditional on amount for destination ${destination}`,
      );
      return lower;
    }
    case HookType.ARB_L2_TO_L1:
      return (
        config.destinationChain === destination &&
        hookUsesLeafFor(matcher, config.childHook, destination)
      );
    default:
      return false;
  }
}

function ismUsesLeafFor<THook extends HookConfig, TIsm extends IsmConfig>(
  matcher: CombinedHookIsmLeafMatcher<THook, TIsm>,
  config: IsmConfig | undefined,
  origin: ChainName,
): boolean {
  if (!config || typeof config === 'string') return false;
  if (matcher.isIsm(config)) return true;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return config.modules.some((ism) => ismUsesLeafFor(matcher, ism, origin));
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return ismUsesLeafFor(matcher, config.domains[origin], origin);
    case IsmType.AMOUNT_ROUTING: {
      const lower = ismUsesLeafFor(matcher, config.lowerIsm, origin);
      const upper = ismUsesLeafFor(matcher, config.upperIsm, origin);
      assert(
        lower === upper,
        `${matcher.label} cannot be conditional on amount for origin ${origin}`,
      );
      return lower;
    }
    default:
      return false;
  }
}

function validateDirectionalPairing<
  THook extends HookConfig,
  TIsm extends IsmConfig,
>(
  matcher: CombinedHookIsmLeafMatcher<THook, TIsm>,
  configs: ChainMap<CombinedHookIsmWarpChainConfig>,
): void {
  const chains = Object.keys(configs);
  for (const origin of chains) {
    for (const destination of chains) {
      if (origin === destination) continue;
      const hookUses = hookUsesLeafFor(
        matcher,
        configs[origin].hook,
        destination,
      );
      const ismUses = ismUsesLeafFor(
        matcher,
        configs[destination].interchainSecurityModule,
        origin,
      );
      assert(
        hookUses === ismUses,
        `${matcher.label} pairing mismatch for ${origin} -> ${destination}: origin hook=${hookUses}, destination ISM=${ismUses}`,
      );
    }
  }
}

/**
 * Replaces the matched hook and ISM leaves of every chain with that chain's
 * deployed combined hook/ISM router.
 */
export function materializeCombinedHookIsmWarpConfig<
  THook extends HookConfig,
  TIsm extends IsmConfig,
  T extends CombinedHookIsmWarpChainConfig,
>(
  matcher: CombinedHookIsmLeafMatcher<THook, TIsm>,
  configs: ChainMap<T>,
  addresses: ChainMap<Address>,
): ChainMap<MaterializedCombinedHookIsmWarpChainConfig<T>> {
  return Object.fromEntries(
    Object.entries(configs).map(([chain, config]) => {
      const address = addresses[chain];
      assert(address, `Missing deployed ${matcher.label} router for ${chain}`);
      assert(config.hook, `${chain} is missing its ${matcher.label} hook tree`);
      assert(
        config.interchainSecurityModule,
        `${chain} is missing its ${matcher.label} ISM tree`,
      );
      return [
        chain,
        {
          ...config,
          hook: mapHookTreeNodes(config.hook, matcher.isHook, () => address),
          interchainSecurityModule: mapIsmTreeNodes(
            config.interchainSecurityModule,
            matcher.isIsm,
            () => address,
          ),
        },
      ];
    }),
  );
}
