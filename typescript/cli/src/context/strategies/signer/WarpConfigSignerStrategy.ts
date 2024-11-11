import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH } from '../../../commands/options.js';
import {
  isFile,
  readYamlOrJson,
  runFileSelectionStep,
} from '../../../utils/files.js';
import { SubmitterContext } from '../submitter/SubmitterContext.js';

import { SignerStrategy } from './SignerStrategy.js';

/**
 * @title WarpConfigSignerStrategy
 * @notice Strategy implementation for managing Warp route deployments and configurations
 * @dev This strategy is used by commands like 'warp:deploy' and 'warp:apply'
 */
export class WarpConfigSignerStrategy implements SignerStrategy {
  /**
   * @notice Determines the chains to be used based on the Warp configuration file
   * @dev Reads and validates a YAML/JSON config file to extract chain information
   *      If no config is provided, prompts for interactive file selection
   */
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const configPath = argv.config || DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH;
    const { chains } = await getWarpConfigChains({
      configPath,
      skipConfirmation: argv.skipConfirmation,
    });

    argv.context.config = configPath;
    argv.context.chains = chains;
    return chains;
  }

  createSubmitterContext(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv: Record<string, any>,
  ): SubmitterContext {
    return new SubmitterContext(
      strategyConfig,
      chains,
      TxSubmitterType.JSON_RPC,
      argv,
    );
  }

  /**
   * @dev Sets up signers for all chains [can be one or more] specified in the Warp config
   */
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
}

/**
 * @notice Helper function to extract and validate chains from a Warp config file
 * @dev Supports both YAML and JSON config formats
 */
export async function getWarpConfigChains({
  configPath = DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
  skipConfirmation = false,
}: {
  configPath?: string;
  skipConfirmation?: boolean;
}): Promise<{ chains: ChainName[] }> {
  // Validate config path

  if (!configPath || !isFile(configPath)) {
    assert(!skipConfirmation, 'Warp route deployment config is required');

    // Interactive file selection if no path provided
    configPath = await runFileSelectionStep(
      './configs',
      'Warp route deployment config',
      'warp',
    );
  } else {
    console.log(`Using warp route deployment config at ${configPath}`);
  }

  // Read warp route deployment configuration
  let warpRouteConfig = readYamlOrJson(configPath);

  assert(warpRouteConfig, `No warp route deploy config found at ${configPath}`);

  // Extract chains from configuration
  const chains = Object.keys(warpRouteConfig) as ChainName[];

  // Validate chains
  assert(
    chains.length !== 0,
    'No chains found in warp route deployment config',
  );

  return { chains };
}
