import { constants } from 'ethers';

import { Address, assert } from '@hyperlane-xyz/utils';

import { HookConfig, HookType, LayerZeroV2HookConfig } from '../hook/types.js';
import { collectHookTreeNodes, mapHookTreeNodes } from '../hook/utils.js';
import { IsmConfig, IsmType, LayerZeroV2IsmConfig } from '../ism/types.js';
import { ChainMap } from '../types.js';
import { collectIsmTreeNodes, mapIsmTreeNodes } from '../utils/ism.js';

import {
  LayerZeroV2HookIsmConfig,
  LayerZeroV2MeshConfig,
  LayerZeroV2Variant,
} from './types.js';

export interface LayerZeroV2WarpChainConfig {
  hook?: HookConfig;
  interchainSecurityModule?: IsmConfig;
  mailbox?: Address;
}

export interface LayerZeroV2ConfigPair {
  hook: LayerZeroV2HookConfig;
  ism: LayerZeroV2IsmConfig;
  variant: LayerZeroV2Variant;
}

export function isLayerZeroV2Hook(
  config: HookConfig | undefined,
): config is LayerZeroV2HookConfig {
  return (
    !!config &&
    typeof config !== 'string' &&
    (config.type === HookType.LAYER_ZERO_V2_CALLBACK ||
      config.type === HookType.LAYER_ZERO_V2_CCIP_READ)
  );
}

export function isLayerZeroV2Ism(
  config: IsmConfig,
): config is LayerZeroV2IsmConfig {
  return (
    typeof config !== 'string' &&
    (config.type === IsmType.LAYER_ZERO_V2_CALLBACK ||
      config.type === IsmType.LAYER_ZERO_V2_CCIP_READ)
  );
}

export function findLayerZeroV2Hooks(
  config: HookConfig | undefined,
): LayerZeroV2HookConfig[] {
  return collectHookTreeNodes(config, isLayerZeroV2Hook);
}

export function findLayerZeroV2Isms(
  config: IsmConfig | undefined,
): LayerZeroV2IsmConfig[] {
  return collectIsmTreeNodes(config, isLayerZeroV2Ism);
}

export function collectHookAddresses(
  config: HookConfig | undefined,
): Address[] {
  if (!config) return [];
  if (typeof config === 'string') return [config];
  const own =
    'address' in config && typeof config.address === 'string'
      ? [config.address]
      : [];
  switch (config.type) {
    case HookType.AGGREGATION:
      return [...own, ...config.hooks.flatMap(collectHookAddresses)];
    case HookType.ROUTING:
      return [
        ...own,
        ...Object.values(config.domains).flatMap(collectHookAddresses),
      ];
    case HookType.FALLBACK_ROUTING:
      return [
        ...own,
        ...Object.values(config.domains).flatMap(collectHookAddresses),
        ...collectHookAddresses(config.fallback),
      ];
    case HookType.AMOUNT_ROUTING:
      return [
        ...own,
        ...collectHookAddresses(config.lowerHook),
        ...collectHookAddresses(config.upperHook),
      ];
    case HookType.ARB_L2_TO_L1:
      return [...own, ...collectHookAddresses(config.childHook)];
    default:
      return own;
  }
}

export function collectIsmAddresses(config: IsmConfig | undefined): Address[] {
  if (!config) return [];
  if (typeof config === 'string') return [config];
  const own =
    'address' in config && typeof config.address === 'string'
      ? [config.address]
      : [];
  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return [...own, ...config.modules.flatMap(collectIsmAddresses)];
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return [
        ...own,
        ...Object.values(config.domains).flatMap(collectIsmAddresses),
      ];
    case IsmType.AMOUNT_ROUTING:
      return [
        ...own,
        ...collectIsmAddresses(config.lowerIsm),
        ...collectIsmAddresses(config.upperIsm),
      ];
    default:
      return own;
  }
}

function hookVariant(hook: LayerZeroV2HookConfig): LayerZeroV2Variant {
  return hook.type === HookType.LAYER_ZERO_V2_CALLBACK
    ? LayerZeroV2Variant.Callback
    : LayerZeroV2Variant.CcipRead;
}

function ismVariant(ism: LayerZeroV2IsmConfig): LayerZeroV2Variant {
  return ism.type === IsmType.LAYER_ZERO_V2_CALLBACK
    ? LayerZeroV2Variant.Callback
    : LayerZeroV2Variant.CcipRead;
}

function hookUsesLayerZeroFor(
  config: HookConfig | undefined,
  destination: string,
): boolean {
  if (!config || typeof config === 'string') return false;
  if (isLayerZeroV2Hook(config)) return true;
  switch (config.type) {
    case HookType.AGGREGATION:
      return config.hooks.some((hook) =>
        hookUsesLayerZeroFor(hook, destination),
      );
    case HookType.ROUTING:
      return hookUsesLayerZeroFor(config.domains[destination], destination);
    case HookType.FALLBACK_ROUTING:
      return hookUsesLayerZeroFor(
        config.domains[destination] ?? config.fallback,
        destination,
      );
    case HookType.AMOUNT_ROUTING: {
      const lower = hookUsesLayerZeroFor(config.lowerHook, destination);
      const upper = hookUsesLayerZeroFor(config.upperHook, destination);
      assert(
        lower === upper,
        `LayerZero cannot be conditional on amount for destination ${destination}`,
      );
      return lower;
    }
    case HookType.ARB_L2_TO_L1:
      return (
        config.destinationChain === destination &&
        hookUsesLayerZeroFor(config.childHook, destination)
      );
    default:
      return false;
  }
}

function ismUsesLayerZeroFor(
  config: IsmConfig | undefined,
  origin: string,
): boolean {
  if (!config || typeof config === 'string') return false;
  if (isLayerZeroV2Ism(config)) return true;
  switch (config.type) {
    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return config.modules.some((ism) => ismUsesLayerZeroFor(ism, origin));
    case IsmType.ROUTING:
    case IsmType.FALLBACK_ROUTING:
    case IsmType.INCREMENTAL_ROUTING:
      return ismUsesLayerZeroFor(config.domains[origin], origin);
    case IsmType.AMOUNT_ROUTING: {
      const lower = ismUsesLayerZeroFor(config.lowerIsm, origin);
      const upper = ismUsesLayerZeroFor(config.upperIsm, origin);
      assert(
        lower === upper,
        `LayerZero cannot be conditional on amount for origin ${origin}`,
      );
      return lower;
    }
    default:
      return false;
  }
}

function validateDirectionalPairing(
  configs: ChainMap<LayerZeroV2WarpChainConfig>,
): void {
  const chains = Object.keys(configs);
  for (const origin of chains) {
    for (const destination of chains) {
      if (origin === destination) continue;
      const hookUses = hookUsesLayerZeroFor(configs[origin].hook, destination);
      const ismUses = ismUsesLayerZeroFor(
        configs[destination].interchainSecurityModule,
        origin,
      );
      assert(
        hookUses === ismUses,
        `LayerZero pairing mismatch for ${origin} -> ${destination}: origin hook=${hookUses}, destination ISM=${ismUses}`,
      );
    }
  }
}

export function pairLayerZeroV2Configs(
  configs: ChainMap<LayerZeroV2WarpChainConfig>,
): ChainMap<LayerZeroV2ConfigPair> {
  const pairs: ChainMap<LayerZeroV2ConfigPair> = {};
  const hasAny = Object.values(configs).some(
    (config) =>
      findLayerZeroV2Hooks(config.hook).length > 0 ||
      findLayerZeroV2Isms(config.interchainSecurityModule).length > 0,
  );
  if (!hasAny) return pairs;

  let meshVariant: LayerZeroV2Variant | undefined;
  for (const [chain, config] of Object.entries(configs)) {
    const hooks = findLayerZeroV2Hooks(config.hook);
    const isms = findLayerZeroV2Isms(config.interchainSecurityModule);
    assert(
      hooks.length === 1,
      `${chain} must contain exactly one LayerZero hook leaf; found ${hooks.length}`,
    );
    assert(
      isms.length === 1,
      `${chain} must contain exactly one LayerZero ISM leaf; found ${isms.length}`,
    );
    const localHookVariant = hookVariant(hooks[0]);
    const localIsmVariant = ismVariant(isms[0]);
    assert(
      localHookVariant === localIsmVariant,
      `${chain} LayerZero hook is ${localHookVariant} but ISM is ${localIsmVariant}`,
    );
    if (localIsmVariant === LayerZeroV2Variant.CcipRead) {
      assert(
        config.interchainSecurityModule === isms[0],
        `${chain} LayerZero CCIP-read ISM must be direct and standalone`,
      );
    }
    meshVariant ??= localHookVariant;
    assert(
      meshVariant === localHookVariant,
      `${chain} uses ${localHookVariant}; mesh already uses ${meshVariant}`,
    );
    pairs[chain] = {
      hook: hooks[0],
      ism: isms[0],
      variant: localHookVariant,
    };
  }
  validateDirectionalPairing(configs);
  return pairs;
}

export function buildLayerZeroV2MeshConfig(
  configs: ChainMap<LayerZeroV2WarpChainConfig>,
  pairs: ChainMap<LayerZeroV2ConfigPair>,
): LayerZeroV2MeshConfig {
  const chains = Object.keys(pairs);
  return Object.fromEntries(
    chains.map((chain) => {
      const local = pairs[chain];
      const mailbox = configs[chain].mailbox;
      assert(mailbox, `${chain} requires a mailbox for LayerZero deployment`);
      const remoteRouters = Object.fromEntries(
        chains
          .filter((remote) => remote !== chain)
          .map((remote) => {
            const pathway = local.ism.pathways[remote];
            assert(pathway, `${chain} has no LayerZero pathway for ${remote}`);
            const callbackGasLimit =
              local.hook.type === HookType.LAYER_ZERO_V2_CALLBACK
                ? local.hook.callbackGasLimits[remote]
                : undefined;
            if (local.variant === LayerZeroV2Variant.Callback) {
              assert(
                callbackGasLimit !== undefined,
                `${chain} has no callback gas limit for ${remote}`,
              );
            }
            return [
              remote,
              {
                ...pathway,
                router: constants.AddressZero,
                callbackGasLimit,
              },
            ];
          }),
      );
      const config: LayerZeroV2HookIsmConfig = {
        type: local.variant,
        owner: local.ism.owner,
        mailbox,
        endpoint: local.ism.endpoint,
        layerZeroDomainId: local.ism.layerZeroDomainId,
        urls:
          local.ism.type === IsmType.LAYER_ZERO_V2_CCIP_READ
            ? local.ism.urls
            : undefined,
        remoteRouters,
      };
      return [chain, config];
    }),
  );
}

export function replaceLayerZeroV2Hook(
  config: HookConfig,
  address: Address,
): HookConfig {
  return mapHookTreeNodes(config, isLayerZeroV2Hook, () => address);
}

export function replaceLayerZeroV2Ism(
  config: IsmConfig,
  address: Address,
): IsmConfig {
  return mapIsmTreeNodes(config, isLayerZeroV2Ism, () => address);
}

export function materializeLayerZeroV2WarpConfig<
  T extends ChainMap<LayerZeroV2WarpChainConfig>,
>(configs: T, addresses: ChainMap<Address>): T {
  return Object.fromEntries(
    Object.entries(configs).map(([chain, config]) => {
      const address = addresses[chain];
      if (!address) return [chain, config];
      assert(config.hook, `${chain} is missing its LayerZero hook tree`);
      assert(
        config.interchainSecurityModule,
        `${chain} is missing its LayerZero ISM tree`,
      );
      return [
        chain,
        {
          ...config,
          hook: replaceLayerZeroV2Hook(config.hook, address),
          interchainSecurityModule: replaceLayerZeroV2Ism(
            config.interchainSecurityModule,
            address,
          ),
        },
      ];
    }),
  ) as T;
}
