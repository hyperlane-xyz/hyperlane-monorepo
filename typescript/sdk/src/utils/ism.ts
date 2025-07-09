import { ChainAddresses } from '@hyperlane-xyz/registry';
import { WithAddress, pick } from '@hyperlane-xyz/utils';

import { multisigIsmVerifyCosts } from '../consts/multisigIsmVerifyCosts.js';

/**
 * Extracts the ISM and Hook factory addresses from chain-specific registry addresses
 * @param registryAddresses The registry addresses for a specific chain
 * @returns The extracted ISM and Hook factory addresses
 */
export function extractIsmAndHookFactoryAddresses(
  registryAddresses: ChainAddresses,
) {
  return pick(registryAddresses, [
    'domainRoutingIsmFactory',
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
      if (key === 'validators' && Array.isArray(config[key])) {
        // Sort the validators array in lexicographical order (since they're already lowercase)
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
