import { constants } from 'ethers';

import { Address, assert } from '@hyperlane-xyz/utils';

import { HookConfig, HookType, WormholeHookConfig } from '../hook/types.js';
import { IsmConfig, IsmType, WormholeIsmConfig } from '../ism/types.js';
import { ChainMap, ChainName } from '../types.js';

import {
  WormholeHookIsmConfig,
  WormholeMeshConfig,
  WormholeVariant,
} from './types.js';
import { consistencyLevelForConfig } from './consistency.js';

export interface WormholeWarpChainConfig {
  hook?: HookConfig;
  interchainSecurityModule?: IsmConfig;
  mailbox?: Address;
}

export interface WormholeConfigPair {
  hook: WormholeHookConfig;
  ism: WormholeIsmConfig;
  variant: WormholeVariant;
}

function isWormholeHook(config: HookConfig): config is WormholeHookConfig {
  return (
    typeof config !== 'string' &&
    (config.type === HookType.WORMHOLE_EXECUTOR ||
      config.type === HookType.WORMHOLE_VAA)
  );
}

function isWormholeIsm(config: IsmConfig): config is WormholeIsmConfig {
  return (
    typeof config !== 'string' &&
    (config.type === IsmType.WORMHOLE_EXECUTOR ||
      config.type === IsmType.WORMHOLE_VAA)
  );
}

export function findWormholeHooks(
  config: HookConfig | undefined,
): WormholeHookConfig[] {
  if (!config || typeof config === 'string') return [];
  if (isWormholeHook(config)) return [config];

  switch (config.type) {
    case HookType.AGGREGATION:
      return config.hooks.flatMap(findWormholeHooks);
    case HookType.ROUTING:
      return Object.values(config.domains).flatMap(findWormholeHooks);
    case HookType.FALLBACK_ROUTING:
      return [
        ...Object.values(config.domains).flatMap(findWormholeHooks),
        ...findWormholeHooks(config.fallback),
      ];
    case HookType.AMOUNT_ROUTING:
      return [
        ...findWormholeHooks(config.lowerHook),
        ...findWormholeHooks(config.upperHook),
      ];
    case HookType.ARB_L2_TO_L1:
      return findWormholeHooks(config.childHook);
    default:
      return [];
  }
}

export function findWormholeIsms(
  config: IsmConfig | undefined,
): WormholeIsmConfig[] {
  if (!config || typeof config === 'string') return [];
  if (isWormholeIsm(config)) return [config];

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return config.modules.flatMap(findWormholeIsms);
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return Object.values(config.domains).flatMap(findWormholeIsms);
    case IsmType.AMOUNT_ROUTING:
      return [
        ...findWormholeIsms(config.lowerIsm),
        ...findWormholeIsms(config.upperIsm),
      ];
    default:
      return [];
  }
}

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

function variantForHook(config: WormholeHookConfig): WormholeVariant {
  return config.type === HookType.WORMHOLE_EXECUTOR
    ? WormholeVariant.Executor
    : WormholeVariant.DirectVaa;
}

function variantForIsm(config: WormholeIsmConfig): WormholeVariant {
  return config.type === IsmType.WORMHOLE_EXECUTOR
    ? WormholeVariant.Executor
    : WormholeVariant.DirectVaa;
}

/**
 * Finds and validates the one combined Wormhole resource represented by the
 * hook and ISM trees on every chain. An empty route returns an empty map.
 */
export function pairWormholeConfigs(
  configs: ChainMap<WormholeWarpChainConfig>,
): ChainMap<WormholeConfigPair> {
  const pairs: ChainMap<WormholeConfigPair> = {};
  let routeVariant: WormholeVariant | undefined;
  const hasAnyWormhole = Object.values(configs).some(
    (config) =>
      findWormholeHooks(config.hook).length > 0 ||
      findWormholeIsms(config.interchainSecurityModule).length > 0,
  );
  if (!hasAnyWormhole) return pairs;

  for (const [chain, config] of Object.entries(configs)) {
    const hooks = findWormholeHooks(config.hook);
    const isms = findWormholeIsms(config.interchainSecurityModule);
    assert(
      hooks.length === 1,
      `${chain} must contain exactly one Wormhole hook leaf; found ${hooks.length}`,
    );
    assert(
      isms.length === 1,
      `${chain} must contain exactly one Wormhole ISM leaf; found ${isms.length}`,
    );

    const hookVariant = variantForHook(hooks[0]);
    const ismVariant = variantForIsm(isms[0]);
    assert(
      hookVariant === ismVariant,
      `${chain} Wormhole hook is ${hookVariant} but ISM is ${ismVariant}`,
    );
    routeVariant ??= hookVariant;
    assert(
      routeVariant === hookVariant,
      `${chain} uses ${hookVariant}; the route already uses ${routeVariant}`,
    );

    pairs[chain] = { hook: hooks[0], ism: isms[0], variant: hookVariant };
  }

  validateDirectionalPairing(configs);
  return pairs;
}

function hookUsesWormholeFor(
  config: HookConfig | undefined,
  destination: ChainName,
): boolean {
  if (!config || typeof config === 'string') return false;
  if (isWormholeHook(config)) return true;

  switch (config.type) {
    case HookType.AGGREGATION:
      return config.hooks.some((hook) =>
        hookUsesWormholeFor(hook, destination),
      );
    case HookType.ROUTING:
      return hookUsesWormholeFor(config.domains[destination], destination);
    case HookType.FALLBACK_ROUTING:
      return hookUsesWormholeFor(
        config.domains[destination] ?? config.fallback,
        destination,
      );
    case HookType.AMOUNT_ROUTING: {
      const lower = hookUsesWormholeFor(config.lowerHook, destination);
      const upper = hookUsesWormholeFor(config.upperHook, destination);
      assert(
        lower === upper,
        `Wormhole cannot be conditional on amount for destination ${destination}`,
      );
      return lower;
    }
    case HookType.ARB_L2_TO_L1:
      return (
        config.destinationChain === destination &&
        hookUsesWormholeFor(config.childHook, destination)
      );
    default:
      return false;
  }
}

function ismUsesWormholeFor(
  config: IsmConfig | undefined,
  origin: ChainName,
): boolean {
  if (!config || typeof config === 'string') return false;
  if (isWormholeIsm(config)) return true;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return config.modules.some((ism) => ismUsesWormholeFor(ism, origin));
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return ismUsesWormholeFor(config.domains[origin], origin);
    case IsmType.AMOUNT_ROUTING: {
      const lower = ismUsesWormholeFor(config.lowerIsm, origin);
      const upper = ismUsesWormholeFor(config.upperIsm, origin);
      assert(
        lower === upper,
        `Wormhole cannot be conditional on amount for origin ${origin}`,
      );
      return lower;
    }
    default:
      return false;
  }
}

function validateDirectionalPairing(
  configs: ChainMap<WormholeWarpChainConfig>,
): void {
  const chains = Object.keys(configs);
  for (const origin of chains) {
    for (const destination of chains) {
      if (origin === destination) continue;
      const hookUses = hookUsesWormholeFor(configs[origin].hook, destination);
      const ismUses = ismUsesWormholeFor(
        configs[destination].interchainSecurityModule,
        origin,
      );
      assert(
        hookUses === ismUses,
        `Wormhole pairing mismatch for ${origin} -> ${destination}: origin hook=${hookUses}, destination ISM=${ismUses}`,
      );
    }
  }
}

export function replaceWormholeHook(
  config: HookConfig,
  address: Address,
): HookConfig {
  if (typeof config === 'string') return config;
  if (isWormholeHook(config)) return address;

  switch (config.type) {
    case HookType.AGGREGATION:
      return {
        ...config,
        hooks: config.hooks.map((hook) => replaceWormholeHook(hook, address)),
      };
    case HookType.ROUTING:
      return {
        ...config,
        domains: Object.fromEntries(
          Object.entries(config.domains).map(([chain, hook]) => [
            chain,
            replaceWormholeHook(hook, address),
          ]),
        ),
      };
    case HookType.FALLBACK_ROUTING:
      return {
        ...config,
        domains: Object.fromEntries(
          Object.entries(config.domains).map(([chain, hook]) => [
            chain,
            replaceWormholeHook(hook, address),
          ]),
        ),
        fallback: replaceWormholeHook(config.fallback, address),
      };
    case HookType.AMOUNT_ROUTING:
      return {
        ...config,
        lowerHook: replaceWormholeHook(config.lowerHook, address),
        upperHook: replaceWormholeHook(config.upperHook, address),
      };
    case HookType.ARB_L2_TO_L1:
      return {
        ...config,
        childHook: replaceWormholeHook(config.childHook, address),
      };
    default:
      return config;
  }
}

export function replaceWormholeIsm(
  config: IsmConfig,
  address: Address,
): IsmConfig {
  if (typeof config === 'string') return config;
  if (isWormholeIsm(config)) return address;

  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return {
        ...config,
        modules: config.modules.map((ism) => replaceWormholeIsm(ism, address)),
      };
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return {
        ...config,
        domains: Object.fromEntries(
          Object.entries(config.domains).map(([chain, ism]) => [
            chain,
            replaceWormholeIsm(ism, address),
          ]),
        ),
      };
    case IsmType.AMOUNT_ROUTING:
      return {
        ...config,
        lowerIsm: replaceWormholeIsm(config.lowerIsm, address),
        upperIsm: replaceWormholeIsm(config.upperIsm, address),
      };
    default:
      return config;
  }
}

export function buildWormholeMeshConfig(
  configs: ChainMap<WormholeWarpChainConfig>,
  pairs: ChainMap<WormholeConfigPair>,
): WormholeMeshConfig {
  const chains = Object.keys(pairs);
  return Object.fromEntries(
    chains.map((chain) => {
      const local = pairs[chain];
      const mailbox = configs[chain].mailbox;
      assert(mailbox, `${chain} requires a mailbox for Wormhole deployment`);

      const remoteRouters = Object.fromEntries(
        chains
          .filter((remote) => remote !== chain)
          .map((remote) => {
            const remoteIsm = pairs[remote].ism;
            const common = {
              router: constants.AddressZero,
              wormholeChainId: remoteIsm.wormholeChainId,
              expectedConsistencyLevel: consistencyLevelForConfig(
                remoteIsm.consistencyLevel,
              ),
            };
            if (local.variant === WormholeVariant.DirectVaa) {
              return [remote, common];
            }

            assert(
              local.hook.type === HookType.WORMHOLE_EXECUTOR,
              `${chain} Executor pair has a non-Executor hook`,
            );
            const route = local.hook.routes[remote];
            assert(
              route,
              `${chain} Wormhole Executor hook is missing route ${remote}`,
            );
            return [remote, { ...common, ...route }];
          }),
      );

      const common: WormholeHookIsmConfig = {
        type: local.variant,
        owner: local.ism.owner,
        mailbox,
        core: local.ism.core,
        wormholeChainId: local.ism.wormholeChainId,
        consistencyLevel: local.ism.consistencyLevel,
        remoteRouters,
        ...(local.variant === WormholeVariant.Executor
          ? {
              executorQuoterRouter:
                local.hook.type === HookType.WORMHOLE_EXECUTOR
                  ? local.hook.executorQuoterRouter
                  : undefined,
            }
          : {
              urls:
                local.ism.type === IsmType.WORMHOLE_VAA
                  ? local.ism.urls
                  : undefined,
            }),
      };
      return [chain, common];
    }),
  );
}

export type MaterializedWormholeWarpChainConfig<
  T extends WormholeWarpChainConfig,
> = T & {
  hook: HookConfig;
  interchainSecurityModule: IsmConfig;
};

export function materializeWormholeWarpConfig<
  T extends WormholeWarpChainConfig,
>(
  configs: ChainMap<T>,
  addresses: ChainMap<Address>,
): ChainMap<MaterializedWormholeWarpChainConfig<T>> {
  return Object.fromEntries(
    Object.entries(configs).map(([chain, config]) => {
      const address = addresses[chain];
      assert(address, `Missing deployed Wormhole router for ${chain}`);
      assert(config.hook, `${chain} is missing its Wormhole hook tree`);
      assert(
        config.interchainSecurityModule,
        `${chain} is missing its Wormhole ISM tree`,
      );
      return [
        chain,
        {
          ...config,
          hook: replaceWormholeHook(config.hook, address),
          interchainSecurityModule: replaceWormholeIsm(
            config.interchainSecurityModule,
            address,
          ),
        },
      ];
    }),
  );
}
