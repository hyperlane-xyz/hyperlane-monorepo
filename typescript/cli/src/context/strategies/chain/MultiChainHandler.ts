import { ChainName } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH } from '../../../commands/options.js';
import { readChainSubmissionStrategyConfig } from '../../../config/strategy.js';
import { logRed } from '../../../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../../../utils/chains.js';
import {
  isFile,
  readYamlOrJson,
  runFileSelectionStep,
} from '../../../utils/files.js';
import { getWarpCoreConfigOrExit } from '../../../utils/input.js';

import { ChainHandler } from './types.js';

enum ChainSelectionMode {
  ORIGIN_DESTINATION,
  AGENT_KURTOSIS,
  WARP_CONFIG,
  WARP_READ,
  STRATEGY,
  RELAYER,
}

export class MultiChainHandler implements ChainHandler {
  constructor(private mode: ChainSelectionMode) {}

  async resolveChains(argv: Record<string, any>): Promise<ChainName[]> {
    switch (this.mode) {
      case ChainSelectionMode.WARP_CONFIG:
        return this.resolveWarpRouteConfigChains(argv);
      case ChainSelectionMode.WARP_READ:
        return this.resolveWarpCoreConfigChains(argv);
      case ChainSelectionMode.AGENT_KURTOSIS:
        return this.resolveAgentChains(argv);
      case ChainSelectionMode.STRATEGY:
        return this.resolveStrategyChains(argv);
      case ChainSelectionMode.RELAYER:
        return this.resolveRelayerChains(argv);
      case ChainSelectionMode.ORIGIN_DESTINATION:
      default:
        return this.resolveOriginDestinationChains(argv);
    }
  }

  private async resolveWarpRouteConfigChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    argv.config ||= DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH;
    argv.context.chains = await this.getWarpRouteConfigChains(
      argv.config.trim(),
      argv.skipConfirmation,
    );
    return argv.context.chains;
  }
  private async resolveWarpCoreConfigChains(
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

  private async resolveOriginDestinationChains(
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
  private async resolveStrategyChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    const strategy = await readChainSubmissionStrategyConfig(argv.strategy);
    return extractChainValues(strategy);
  }
  private async resolveRelayerChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    return argv.chains.split(',').map((item: string) => item.trim());
  }

  private async getWarpRouteConfigChains(
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

    // @dev instead of using readWarpRouteDeployConfig, which uses context to get the signer to fill defaults and make file pass zod validation
    const warpRouteConfig = (await readYamlOrJson(configPath)) as Record<
      string,
      any
    >;

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
  static forRelayer(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.RELAYER);
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
