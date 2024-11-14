import { ChainName } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH } from '../../../commands/options.js';
import { readStrategyConfig } from '../../../config/strategy.js';
import { readWarpRouteDeployConfig } from '../../../config/warp.js';
import { logRed } from '../../../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../../../utils/chains.js';
import { isFile, runFileSelectionStep } from '../../../utils/files.js';
import { getWarpCoreConfigOrExit } from '../../../utils/input.js';

import { ChainHandler } from './types.js';

enum ChainSelectionMode {
  ORIGIN_DESTINATION,
  AGENT_KURTOSIS,
  WARP_CONFIG,
  WARP_READ,
  STRATEGY,
}

export class MultiChainHandler implements ChainHandler {
  constructor(private mode: ChainSelectionMode) {}

  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    switch (this.mode) {
      case ChainSelectionMode.WARP_CONFIG:
        return this.determineWarpRouteConfigChains(argv);
      case ChainSelectionMode.WARP_READ:
        return this.determineWarpCoreConfigChains(argv);
      case ChainSelectionMode.AGENT_KURTOSIS:
        return this.determineAgentChains(argv);
      case ChainSelectionMode.STRATEGY:
        return this.determineStrategyChains(argv);
      case ChainSelectionMode.ORIGIN_DESTINATION:
      default:
        return this.determineOriginDestinationChains(argv);
    }
  }

  private async determineWarpRouteConfigChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    argv.config = argv.config || DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH;
    argv.context.chains = await this.getWarpConfigChains(
      argv.config,
      argv.skipConfirmation,
    );
    return argv.context.chains;
  }
  private async determineWarpCoreConfigChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    if (argv.symbol || argv.warp) {
      const warpCoreConfig = await getWarpCoreConfigOrExit({
        context: argv.context,
        warp: argv.warp,
        symbol: argv.symbol,
      });
      argv.context.warpCoreConfig = warpCoreConfig;
      const chains = extractChainValues(warpCoreConfig);
      return chains;
    } else if (argv.chain) {
      return [argv.chain];
    } else {
      throw new Error(
        `Please specify either a symbol, chain and address or warp file`,
      );
    }
  }

  private async determineAgentChains(
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

  private async determineOriginDestinationChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const { chainMetadata } = argv.context;

    argv.origin =
      argv.origin ??
      (await runSingleChainSelectionStep(
        chainMetadata,
        'Select the origin chain',
      ));

    argv.destination =
      argv.destination ??
      (await runSingleChainSelectionStep(
        chainMetadata,
        'Select the destination chain',
      ));

    return [argv.origin, argv.destination];
  }
  private async determineStrategyChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const strategy = await readStrategyConfig(argv.strategy);
    return extractChainValues(strategy);
  }

  private async getWarpConfigChains(
    configPath: string,
    skipConfirmation: boolean,
  ): Promise<ChainName[]> {
    if (!configPath || !isFile(configPath)) {
      assert(!skipConfirmation, 'Warp route deployment config is required');
      configPath = await runFileSelectionStep(
        './configs',
        'Warp route deployment config',
        'warp',
      );
    } else {
      logRed(`Using warp route deployment config at ${configPath}`);
    }

    const warpRouteConfig = await readWarpRouteDeployConfig(configPath);

    const chains = Object.keys(warpRouteConfig) as ChainName[];
    assert(
      chains.length !== 0,
      'No chains found in warp route deployment config',
    );

    return chains;
  }

  static forOriginDestination(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.ORIGIN_DESTINATION);
  }

  static forAgentKurtosis(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.AGENT_KURTOSIS);
  }

  static forWarpRouteConfig(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.WARP_CONFIG);
  }
  static forWarpCoreConfig(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.WARP_READ);
  }
  static forStrategyConfig(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.STRATEGY);
  }
}

// TODO: Put in helpers
function extractChainValues(config: Record<string, any>): string[] {
  const chains: string[] = [];

  // Function to recursively search for chain fields
  function findChainFields(obj: any) {
    // Return if value is null or not an object/array
    if (obj === null || typeof obj !== 'object') return;

    // Handle arrays
    if (Array.isArray(obj)) {
      obj.forEach((item) => findChainFields(item));
      return;
    }

    // Check for chain fields
    if ('chain' in obj) {
      chains.push(obj.chain);
    }
    if ('chainName' in obj) {
      chains.push(obj.chainName);
    }

    // Recursively search in all object values
    Object.values(obj).forEach((value) => findChainFields(value));
  }

  findChainFields(config);
  return chains;
}
