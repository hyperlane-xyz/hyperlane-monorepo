import { WithAddress } from './types.js';

/**
 * Utilities for normalizing and comparing configuration objects.
 * Used across ISM, Hook, and other Hyperlane configurations.
 */

/**
 * Recursively normalizes a config object for comparison by:
 * - Removing address and ownerOverrides fields (deployment-specific)
 * - Lowercasing all string values (except 'type' fields)
 * - Sorting specific arrays (validators, modules, hooks)
 *
 * @param obj - Configuration object to normalize
 * @returns Normalized configuration object
 */
export function normalizeConfig(obj: WithAddress<any>): any {
  return sortArraysInConfig(lowerCaseConfig(obj));
}

/**
 * Recursively lowercases string values in a config object while:
 * - Removing 'address' and 'ownerOverrides' properties
 * - Preserving 'type' property values as-is
 *
 * @param obj - Object to process
 * @returns Processed object with lowercase strings
 */
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

/**
 * Recursively sorts arrays in a config object with special handling for:
 * - validators: sorted in lexicographical order
 * - modules/hooks: sorted by their 'type' property
 *
 * @param config - Configuration object to sort
 * @returns Configuration object with sorted arrays
 */
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
