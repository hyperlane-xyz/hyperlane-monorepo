import {
  type RebalancerConfigFileInput,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
} from '@hyperlane-xyz/rebalancer';
import { Address } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';

import { RebalancerTestSetup } from './setup.js';

// Default path for rebalancer config in tests
export const DEFAULT_REBALANCER_CONFIG_PATH = '/tmp/rebalancer-config.yaml';

export interface WeightedChainConfig {
  weight: number;
  tolerance?: number;
  bridge: Address;
  bridgeLockTime?: number;
  bridgeMinAcceptedAmount?: string;
  bridgeIsWarp?: boolean;
}

export interface MinAmountChainConfig {
  min: string;
  target: string;
  type?: RebalancerMinAmountType;
  bridge: Address;
  bridgeLockTime?: number;
  bridgeMinAcceptedAmount?: string;
  bridgeIsWarp?: boolean;
}

export interface WriteWeightedConfigOptions {
  setup: RebalancerTestSetup;
  chains: Record<string, WeightedChainConfig>;
  warpRouteId?: string;
  outputPath?: string;
}

export interface WriteMinAmountConfigOptions {
  setup: RebalancerTestSetup;
  chains: Record<string, MinAmountChainConfig>;
  warpRouteId?: string;
  outputPath?: string;
}

/**
 * Write a weighted strategy rebalancer config.
 *
 * @param options Configuration options
 * @returns Path to the written config file
 */
export function writeWeightedConfig(
  options: WriteWeightedConfigOptions,
): string {
  const {
    setup: _setup,
    chains,
    warpRouteId = 'TST/test',
    outputPath = DEFAULT_REBALANCER_CONFIG_PATH,
  } = options;
  void _setup; // Used for future extensibility

  const config: RebalancerConfigFileInput = {
    warpRouteId,
    strategy: {
      rebalanceStrategy: RebalancerStrategyOptions.Weighted,
      chains: Object.fromEntries(
        Object.entries(chains).map(([chainName, chainConfig]) => [
          chainName,
          {
            weighted: {
              weight: chainConfig.weight.toString(),
              tolerance: (chainConfig.tolerance ?? 0).toString(),
            },
            bridge: chainConfig.bridge,
            bridgeLockTime: chainConfig.bridgeLockTime ?? 1,
            bridgeMinAcceptedAmount: chainConfig.bridgeMinAcceptedAmount,
            bridgeIsWarp: chainConfig.bridgeIsWarp,
          },
        ]),
      ),
    },
  };

  writeYamlOrJson(outputPath, config);
  return outputPath;
}

/**
 * Write a minAmount strategy rebalancer config.
 *
 * @param options Configuration options
 * @returns Path to the written config file
 */
export function writeMinAmountConfig(
  options: WriteMinAmountConfigOptions,
): string {
  const {
    setup: _setup,
    chains,
    warpRouteId = 'TST/test',
    outputPath = DEFAULT_REBALANCER_CONFIG_PATH,
  } = options;
  void _setup; // Used for future extensibility

  const config: RebalancerConfigFileInput = {
    warpRouteId,
    strategy: {
      rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
      chains: Object.fromEntries(
        Object.entries(chains).map(([chainName, chainConfig]) => [
          chainName,
          {
            minAmount: {
              min: chainConfig.min,
              target: chainConfig.target,
              type: chainConfig.type ?? RebalancerMinAmountType.Absolute,
            },
            bridge: chainConfig.bridge,
            bridgeLockTime: chainConfig.bridgeLockTime ?? 1,
            bridgeMinAcceptedAmount: chainConfig.bridgeMinAcceptedAmount,
            bridgeIsWarp: chainConfig.bridgeIsWarp,
          },
        ]),
      ),
    },
  };

  writeYamlOrJson(outputPath, config);
  return outputPath;
}

/**
 * Helper to create weighted config for equal weights across domains.
 * Uses bridges from the test setup.
 *
 * @param setup Test setup
 * @param domainNames Domains to include
 * @param tolerance Optional tolerance (default 0)
 * @returns Config options for writeWeightedConfig
 */
export function createEqualWeightedConfig(
  setup: RebalancerTestSetup,
  domainNames: string[],
  tolerance = 0,
): WriteWeightedConfigOptions {
  const weight = Math.floor(100 / domainNames.length);

  const chains: Record<string, WeightedChainConfig> = {};
  for (const domainName of domainNames) {
    // Find a bridge for this domain (use first available destination)
    const otherDomain = domainNames.find((d) => d !== domainName);
    const bridge = otherDomain
      ? setup.getBridge(domainName, otherDomain)
      : '0x0000000000000000000000000000000000000000';

    chains[domainName] = {
      weight,
      tolerance,
      bridge,
      bridgeLockTime: 1,
    };
  }

  return { setup, chains };
}

/**
 * Helper to create minAmount config with absolute thresholds.
 * Uses bridges from the test setup.
 *
 * @param setup Test setup
 * @param domainConfigs Map of domain name to {min, target} in human-readable units
 * @returns Config options for writeMinAmountConfig
 */
export function createMinAmountConfig(
  setup: RebalancerTestSetup,
  domainConfigs: Record<string, { min: string; target: string }>,
): WriteMinAmountConfigOptions {
  const domainNames = Object.keys(domainConfigs);

  const chains: Record<string, MinAmountChainConfig> = {};
  for (const domainName of domainNames) {
    // Find a bridge for this domain (use first available destination)
    const otherDomain = domainNames.find((d) => d !== domainName);
    const bridge = otherDomain
      ? setup.getBridge(domainName, otherDomain)
      : '0x0000000000000000000000000000000000000000';

    chains[domainName] = {
      min: domainConfigs[domainName].min,
      target: domainConfigs[domainName].target,
      type: RebalancerMinAmountType.Absolute,
      bridge,
      bridgeLockTime: 1,
    };
  }

  return { setup, chains };
}
