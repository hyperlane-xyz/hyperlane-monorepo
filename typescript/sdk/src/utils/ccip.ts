import { CCIPHook, CCIPIsm } from '@hyperlane-xyz/core';

import { CCIP_NETWORKS } from '../consts/ccip.js';
import { HyperlaneAddressesMap } from '../contracts/types.js';
import { ChainName } from '../types.js';

/**
 * Gets the chain name from a CCIP chain selector value
 * @param chainSelector The CCIP chain selector value
 * @returns The chain name if found, undefined otherwise
 */
export function getChainNameFromCCIPSelector(
  chainSelector: string,
): string | undefined {
  for (const [chainName, networkInfo] of Object.entries(CCIP_NETWORKS)) {
    if (networkInfo.chainSelector === chainSelector) {
      return chainName;
    }
  }
  return undefined;
}

/**
 * Gets the CCIP chain selector value for a given chain name
 * @param chainName The name of the chain
 * @returns The CCIP chain selector if found, undefined otherwise
 */
export function getCCIPChainSelector(chainName: string): string | undefined {
  return CCIP_NETWORKS[chainName]?.chainSelector;
}

/**
 * Gets the CCIP router address for a given chain name
 * @param chainName The name of the chain
 * @returns The CCIP router address if found, undefined otherwise
 */
export function getCCIPRouterAddress(chainName: string): string | undefined {
  return CCIP_NETWORKS[chainName]?.router?.address;
}

/**
 * Gets the list of chains supported by CCIP
 * @returns The list of chain names
 */
export function getCCIPChains(): string[] {
  return Object.keys(CCIP_NETWORKS);
}

export const CCIP_HOOK_KEY_PREFIX = 'ccipHook';
export const CCIP_ISM_KEY_PREFIX = 'ccipIsm';

export class CCIPContractCache {
  private cachedAddresses: HyperlaneAddressesMap<any> = {};

  cacheAddressesMap(addressesMap: HyperlaneAddressesMap<any>): void {
    this.cachedAddresses = addressesMap;
  }

  getAddressesMap(): HyperlaneAddressesMap<any> {
    return this.cachedAddresses;
  }

  writeBack(cachedAddresses: HyperlaneAddressesMap<any>): void {
    for (const [origin, destinations] of Object.entries(this.cachedAddresses)) {
      if (!cachedAddresses[origin]) {
        cachedAddresses[origin] = {};
      }
      for (const [key, address] of Object.entries(destinations)) {
        cachedAddresses[origin][key] = address;
      }
    }
  }

  setHook(origin: ChainName, destination: ChainName, ccipHook: CCIPHook): void {
    if (!this.cachedAddresses[origin]) {
      this.cachedAddresses[origin] = {};
    }
    this.cachedAddresses[origin][`${CCIP_HOOK_KEY_PREFIX}-${destination}`] =
      ccipHook.address;
  }

  setIsm(origin: ChainName, destination: ChainName, ccipIsm: CCIPIsm): void {
    if (!this.cachedAddresses[destination]) {
      this.cachedAddresses[destination] = {};
    }
    this.cachedAddresses[destination][`${CCIP_ISM_KEY_PREFIX}-${origin}`] =
      ccipIsm.address;
  }

  getHook(origin: ChainName, destination: ChainName): string | undefined {
    return this.cachedAddresses[origin]?.[
      `${CCIP_HOOK_KEY_PREFIX}-${destination}`
    ];
  }

  getIsm(origin: ChainName, destination: ChainName): string | undefined {
    return this.cachedAddresses[destination]?.[
      `${CCIP_ISM_KEY_PREFIX}-${origin}`
    ];
  }
}
