import {
  ChainMap,
  ChainName,
  DeployedCoreAddresses,
  DeployedCoreAddressesSchema,
  EvmCoreModule,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readCoreDeployConfigs } from '../../../config/core.js';
import { getWarpRouteDeployConfig } from '../../../config/warp.js';
import { RebalancerConfig } from '../../../rebalancer/config/RebalancerConfig.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../../../utils/chains.js';
import { getWarpConfigs } from '../../../utils/warp.js';
import { requestAndSaveApiKeys } from '../../context.js';

import { ChainResolver } from './types.js';

enum ChainSelectionMode {
  AGENT_KURTOSIS,
  WARP_CONFIG,
  WARP_APPLY,
  WARP_REBALANCER,
  STRATEGY,
  CORE_APPLY,
  CORE_DEPLOY,
  CORE_READ,
  DEFAULT,
}

// This class could be broken down into multiple strategies

/**
 * @title MultiChainResolver
 * @notice Resolves chains based on the specified selection mode.
 */
export class MultiChainResolver implements ChainResolver {
  constructor(private mode: ChainSelectionMode) {}

  async resolveChains(argv: ChainMap<any>): Promise<ChainName[]> {
    switch (this.mode) {
      case ChainSelectionMode.STRATEGY:
      case ChainSelectionMode.WARP_CONFIG:
        return this.resolveWarpRouteConfigChains(argv);
      case ChainSelectionMode.WARP_APPLY:
        return this.resolveWarpApplyChains(argv);
      case ChainSelectionMode.WARP_REBALANCER:
        return this.resolveWarpRebalancerChains(argv);
      case ChainSelectionMode.AGENT_KURTOSIS:
        return this.resolveAgentChains(argv);
      case ChainSelectionMode.CORE_APPLY:
        return this.resolveCoreApplyChains(argv);
      case ChainSelectionMode.CORE_READ:
      case ChainSelectionMode.CORE_DEPLOY:
        return this.resolveCoreDeployChains(argv);
      case ChainSelectionMode.DEFAULT:
      default:
        return this.resolveRelayerChains(argv);
    }
  }

  private async resolveWarpRouteConfigChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const warpDeployConfig = await getWarpRouteDeployConfig({
      context: argv.context,
      warpRouteDeployConfigPath: argv.config,
      warpRouteId: argv.warpRouteId,
      symbol: argv.symbol,
    });
    argv.context.warpDeployConfig = warpDeployConfig;
    argv.context.chains = Object.keys(warpDeployConfig);
    assert(
      argv.context.chains.length !== 0,
      'No chains found in warp route deployment config',
    );
    return argv.context.chains;
  }

  private async resolveWarpApplyChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const { warpCoreConfig, warpDeployConfig } = await getWarpConfigs({
      context: argv.context,
      warpRouteId: argv.warpRouteId,
      symbol: argv.symbol,
      warpDeployConfigPath: argv.config,
      warpCoreConfigPath: argv.warp,
    });
    argv.context.warpCoreConfig = warpCoreConfig;
    argv.context.warpDeployConfig = warpDeployConfig;
    argv.context.chains = Object.keys(warpDeployConfig);

    assert(
      argv.context.chains.length !== 0,
      'No chains found in warp route deployment config',
    );
    return argv.context.chains;
  }

  private async resolveWarpRebalancerChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    // Load rebalancer config to get the configured chains
    const rebalancerConfig = RebalancerConfig.load(argv.config);

    // Extract chain names from the rebalancer config's strategy.chains
    // This ensures we only create signers for chains we can actually rebalance
    const chains = Object.keys(rebalancerConfig.strategyConfig.chains);

    assert(chains.length !== 0, 'No chains configured in rebalancer config');

    return chains;
  }

  private async resolveAgentChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const { chainMetadata } = argv.context;
    argv.origin =
      argv.origin ??
      (await runSingleChainSelectionStep(
        chainMetadata,
        'Select the origin chain',
      ));

    if (!argv.targets) {
      const selectedRelayChains = await runMultiChainSelectionStep({
        chainMetadata: chainMetadata,
        message: 'Select chains to relay between',
        requireNumber: 2,
      });
      argv.targets = selectedRelayChains.join(',');
    }

    return [argv.origin, ...argv.targets];
  }

  private async resolveRelayerChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const { multiProvider } = argv.context;
    const chains = new Set<ChainName>();

    if (argv.origin) {
      chains.add(argv.origin);
    }

    if (argv.chain) {
      chains.add(argv.chain);
    }

    if (argv.chains) {
      const additionalChains = argv.chains
        .split(',')
        .map((item: string) => item.trim());
      return Array.from(new Set([...chains, ...additionalChains]));
    }

    // If no destination is specified, return all EVM chains only
    if (!argv.destination) {
      const chains = multiProvider.getKnownChainNames();

      return chains.filter(
        (chain: string) =>
          ProtocolType.Ethereum === multiProvider.getProtocol(chain),
      );
    }

    chains.add(argv.destination);
    return Array.from(chains);
  }

  private async resolveCoreApplyChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    try {
      const config = readCoreDeployConfigs(argv.config);

      if (!config?.interchainAccountRouter) {
        return [argv.chain];
      }

      const addresses = await argv.context.registry.getChainAddresses(
        argv.chain,
      );
      const coreAddresses = DeployedCoreAddressesSchema.parse(
        addresses,
      ) as DeployedCoreAddresses;

      const protocolType = argv.context.multiProvider.getProtocol(argv.chain);

      switch (protocolType) {
        case ProtocolType.Ethereum: {
          const evmCoreModule = new EvmCoreModule(argv.context.multiProvider, {
            chain: argv.chain,
            config,
            addresses: coreAddresses,
          });

          const transactions = await evmCoreModule.update(config);

          return Array.from(new Set(transactions.map((tx) => tx.chainId))).map(
            (chainId) => argv.context.multiProvider.getChainName(chainId),
          );
        }
        default: {
          return [argv.chain];
        }
      }
    } catch (error) {
      throw new Error(`Failed to resolve core apply chains`, {
        cause: error,
      });
    }
  }

  private async resolveCoreDeployChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    try {
      const { chainMetadata, registry, skipConfirmation } = argv.context;

      let chain: string;

      if (argv.chain) {
        chain = argv.chain;
      } else {
        if (skipConfirmation) throw new Error('No chain provided');
        chain = await runSingleChainSelectionStep(
          chainMetadata,
          'Select chain to connect:',
        );
      }
      if (!skipConfirmation) {
        argv.context.apiKeys = await requestAndSaveApiKeys(
          [chain],
          chainMetadata,
          registry,
        );
      }

      argv.chain = chain;
      return [chain];
    } catch (error) {
      throw new Error(`Failed to resolve core deploy chains`, {
        cause: error,
      });
    }
  }

  static forAgentKurtosis(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.AGENT_KURTOSIS);
  }

  static forRelayer(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.DEFAULT);
  }

  static forStrategyConfig(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.STRATEGY);
  }

  static forWarpRouteConfig(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.WARP_CONFIG);
  }
  static forWarpApply(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.WARP_APPLY);
  }

  static forWarpRebalancer(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.WARP_REBALANCER);
  }

  static forCoreApply(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.CORE_APPLY);
  }

  static forCoreDeploy(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.CORE_DEPLOY);
  }

  static forCoreRead(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.CORE_READ);
  }

  static default(): MultiChainResolver {
    return new MultiChainResolver(ChainSelectionMode.DEFAULT);
  }
}
