import { Address, WithAddress, pick } from '@hyperlane-xyz/utils';

import { multisigIsmVerifyCosts } from '../consts/multisigIsmVerifyCosts.js';
import { IsmConfig, IsmType } from '../ism/types.js';

type ChainAddresses = Record<string, string>;

/**
 * Extracts the ISM and Hook factory addresses from chain-specific registry addresses
 * @param registryAddresses The registry addresses for a specific chain
 * @returns The extracted ISM and Hook factory addresses
 */
export function ismTreeContainsRateLimited(ism: unknown): boolean {
  if (typeof ism !== 'object' || ism === null) return false;
  const node = ism as Record<string, unknown>;
  if (node.type === IsmType.RATE_LIMITED) return true;
  if (Array.isArray(node.modules)) {
    if (node.modules.some(ismTreeContainsRateLimited)) return true;
  }
  if (node.domains !== null && typeof node.domains === 'object') {
    if (
      Object.values(node.domains as Record<string, unknown>).some(
        ismTreeContainsRateLimited,
      )
    )
      return true;
  }
  if (ismTreeContainsRateLimited(node.lowerIsm)) return true;
  if (ismTreeContainsRateLimited(node.upperIsm)) return true;
  return false;
}

/**
 * Recursively sets `recipient` on all RATE_LIMITED ISM nodes in the config tree.
 * Pass `undefined` to strip the field.
 * `defaultOwner` is set on nodes that don't have an explicit owner.
 */
export function setRateLimitedIsmRecipient(
  ismConfig: IsmConfig,
  recipient: Address | undefined,
  defaultOwner?: string,
): IsmConfig {
  if (typeof ismConfig === 'string') return ismConfig;

  if (ismConfig.type === IsmType.RATE_LIMITED) {
    return {
      ...ismConfig,
      recipient,
      ...(defaultOwner != null && ismConfig.owner == null
        ? { owner: defaultOwner }
        : {}),
    };
  }

  if (
    ismConfig.type === IsmType.AGGREGATION ||
    ismConfig.type === IsmType.STORAGE_AGGREGATION
  ) {
    return {
      ...ismConfig,
      modules: ismConfig.modules.map((m) =>
        setRateLimitedIsmRecipient(m, recipient, defaultOwner),
      ),
    };
  }

  if (
    ismConfig.type === IsmType.ROUTING ||
    ismConfig.type === IsmType.FALLBACK_ROUTING ||
    ismConfig.type === IsmType.INCREMENTAL_ROUTING
  ) {
    const newDomains: Record<string, IsmConfig> = {};
    for (const [domain, domainIsm] of Object.entries(ismConfig.domains)) {
      newDomains[domain] = setRateLimitedIsmRecipient(
        domainIsm,
        recipient,
        defaultOwner,
      );
    }
    return { ...ismConfig, domains: newDomains };
  }

  if (ismConfig.type === IsmType.AMOUNT_ROUTING) {
    return {
      ...ismConfig,
      lowerIsm: setRateLimitedIsmRecipient(
        ismConfig.lowerIsm,
        recipient,
        defaultOwner,
      ),
      upperIsm: setRateLimitedIsmRecipient(
        ismConfig.upperIsm,
        recipient,
        defaultOwner,
      ),
    };
  }

  return ismConfig;
}

export function extractIsmAndHookFactoryAddresses(
  registryAddresses: ChainAddresses,
) {
  return pick(registryAddresses as Record<string, string>, [
    'domainRoutingIsmFactory',
    'incrementalDomainRoutingIsmFactory',
    'staticMerkleRootMultisigIsmFactory',
    'staticMessageIdMultisigIsmFactory',
    'staticAggregationIsmFactory',
    'staticAggregationHookFactory',
    'staticMerkleRootWeightedMultisigIsmFactory',
    'staticMessageIdWeightedMultisigIsmFactory',
  ]);
}

export function multisigIsmVerificationCost(m: number, n: number): number {
  if (
    !(`${n}` in multisigIsmVerifyCosts) ||
    // @ts-ignore
    !(`${m}` in multisigIsmVerifyCosts[`${n}`])
  ) {
    throw new Error(`No multisigIsmVerificationCost found for ${m}-of-${n}`);
  }
  // @ts-ignore
  return multisigIsmVerifyCosts[`${n}`][`${m}`];
}

// Function to recursively remove 'address' properties and lowercase string properties
export function normalizeConfig(obj: WithAddress<any>): any {
  return sortArraysInConfig(lowerCaseConfig(obj));
}

function lowerCaseConfig(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(normalizeConfig);
  } else if (obj !== null && typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      if (key !== 'address' && key !== 'ownerOverrides') {
        newObj[key] = key === 'type' ? obj[key] : normalizeConfig(obj[key]);
      }
    }
    return newObj;
  } else if (typeof obj === 'string') {
    return obj.toLowerCase();
  }

  return obj;
}

// write a function that will go through an object and sort any arrays it finds
export function sortArraysInConfig(config: any): any {
  // Check if the current object is an array
  if (Array.isArray(config)) {
    return config.map(sortArraysInConfig);
  }
  // Check if it's an object and not null
  else if (typeof config === 'object' && config !== null) {
    const sortedConfig: any = {};
    for (const key in config) {
      if (
        (key === 'validators' || key === 'blacklistedIds') &&
        Array.isArray(config[key])
      ) {
        sortedConfig[key] = [...config[key]].sort();
      }
      // if key is modules or hooks, sort the objects in the array by their 'type' property
      else if (
        (key === 'modules' || key === 'hooks') &&
        Array.isArray(config[key])
      ) {
        sortedConfig[key] = [...config[key]].sort((a: any, b: any) => {
          if (a.type < b.type) return -1;
          if (a.type > b.type) return 1;
          return 0;
        });
      } else {
        // Recursively apply sorting to other fields
        sortedConfig[key] = sortArraysInConfig(config[key]);
      }
    }
    return sortedConfig;
  }

  return config;
}
