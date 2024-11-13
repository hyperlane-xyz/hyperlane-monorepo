import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH } from '../../../commands/options.js';
import { readWarpRouteDeployConfig } from '../../../config/warp.js';
import { logRed } from '../../../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../../../utils/chains.js';
import { isFile, runFileSelectionStep } from '../../../utils/files.js';
import { SubmitterContext } from '../submitter/SubmitterContext.js';

import { ChainHandler } from './types.js';

enum ChainSelectionMode {
  ORIGIN_DESTINATION,
  AGENT_KURTOSIS,
  WARP_CONFIG,
}

export class MultiChainHandler implements ChainHandler {
  constructor(private mode: ChainSelectionMode) {}

  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const { context } = argv;

    switch (this.mode) {
      case ChainSelectionMode.WARP_CONFIG:
        return this.determineWarpConfigChains(argv);
      case ChainSelectionMode.AGENT_KURTOSIS:
        return this.determineAgentChains(argv, context);
      case ChainSelectionMode.ORIGIN_DESTINATION:
      default:
        return this.determineOriginDestinationChains(argv, context);
    }
  }

  private async determineWarpConfigChains(
    argv: Record<string, any>,
  ): Promise<ChainName[]> {
    argv.config = argv.config || DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH;
    argv.context.chains = await this.getWarpConfigChains(
      argv.config,
      argv.skipConfirmation,
    );
    return argv.context.chains;
  }

  private async determineAgentChains(
    argv: Record<string, any>,
    context: any,
  ): Promise<ChainName[]> {
    argv.origin =
      argv.origin ??
      (await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the origin chain',
      ));

    if (!argv.targets) {
      const selectedRelayChains = await runMultiChainSelectionStep({
        chainMetadata: context.chainMetadata,
        message: 'Select chains to relay between',
        requireNumber: 2,
      });
      argv.targets = selectedRelayChains.join(',');
    }

    return [argv.origin, ...argv.targets];
  }

  private async determineOriginDestinationChains(
    argv: Record<string, any>,
    context: any,
  ): Promise<ChainName[]> {
    argv.origin =
      argv.origin ??
      (await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the origin chain',
      ));

    argv.destination =
      argv.destination ??
      (await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the destination chain',
      ));

    return [argv.origin, argv.destination];
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

  createSubmitterContext(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv?: Record<string, any>,
  ): SubmitterContext {
    return new SubmitterContext(
      strategyConfig,
      chains,
      TxSubmitterType.JSON_RPC,
      argv,
    );
  }

  async configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    submitterContext: SubmitterContext,
  ): Promise<void> {
    const signers = await submitterContext.getSigners();
    multiProvider.setSigners(signers);
    argv.context.multiProvider = multiProvider;
    argv.submitterContext = submitterContext;
  }

  static forOriginDestination(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.ORIGIN_DESTINATION);
  }

  static forAgentKurtosis(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.AGENT_KURTOSIS);
  }

  static forWarpConfig(): MultiChainHandler {
    return new MultiChainHandler(ChainSelectionMode.WARP_CONFIG);
  }
}
