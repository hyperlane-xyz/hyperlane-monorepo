import { confirm } from '@inquirer/prompts';

import { ChainName, MultiProvider, TxSubmitterType } from '@hyperlane-xyz/sdk';

import { DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH } from '../../../commands/options.js';
import { readWarpRouteDeployConfig } from '../../../config/warp.js';
import { runSingleChainSelectionStep } from '../../../utils/chains.js';
import { isFile, runFileSelectionStep } from '../../../utils/files.js';
import { ContextManager } from '../../manager/ContextManager.js';

export interface WarpDeployContextResult {
  warpRouteConfig: Record<ChainName, any>;
  chains: ChainName[];
}

export interface SignerStrategy {
  /**
   * Determines the chains to be used for signing
   * @param argv Command arguments
   * @returns Array of chain names
   */
  determineChains(argv: Record<string, any>): Promise<ChainName[]>;

  /**
   * Creates a context manager for the selected chains
   * @param chains Selected chains
   * @param defaultStrategy Default strategy configuration
   * @returns ContextManager instance
   */
  createContextManager(
    chains: ChainName[],
    defaultStrategy: any,
  ): ContextManager;

  /**
   * Configures signers for the multi-provider
   * @param argv Command arguments
   * @param multiProvider MultiProvider instance
   * @param contextManager ContextManager instance
   */
  configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    contextManager: ContextManager,
  ): Promise<void>;
}

export class SingleChainSignerStrategy implements SignerStrategy {
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const chain: ChainName =
      argv.chain ||
      (await runSingleChainSelectionStep(
        argv.context.chainMetadata,
        'Select chain to connect:',
      ));

    argv.chain = chain;
    return [chain]; // Explicitly return as single-item array
  }

  createContextManager(
    chains: ChainName[],
    defaultStrategy: any,
  ): ContextManager {
    return new ContextManager(
      defaultStrategy,
      chains,
      TxSubmitterType.JSON_RPC,
    );
  }

  async configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    contextManager: ContextManager,
  ): Promise<void> {
    const signers = await contextManager.getSigners();
    multiProvider.setSigners(signers);
    argv.context.multiProvider = multiProvider;
    argv.contextManager = contextManager;
  }
}

export class WarpDeploySignerStrategy implements SignerStrategy {
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const { warpRouteConfig, chains } = await getWarpDeployContext({
      configPath: argv.wd || DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
      skipConfirmation: argv.skipConfirmation,
      context: argv.context,
    });

    argv.context.warpRouteConfig = warpRouteConfig;
    argv.context.chains = chains;
    return chains;
  }

  createContextManager(
    chains: ChainName[],
    defaultStrategy: any,
  ): ContextManager {
    return new ContextManager(
      defaultStrategy,
      chains,
      TxSubmitterType.JSON_RPC,
    );
  }

  async configureSigners(
    argv: Record<string, any>,
    multiProvider: MultiProvider,
    contextManager: ContextManager,
  ): Promise<void> {
    const signers = await contextManager.getSigners();
    multiProvider.setSigners(signers);
    argv.context.multiProvider = multiProvider;
    argv.contextManager = contextManager;
  }
}

export class SignerStrategyFactory {
  static createStrategy(argv: Record<string, any>): SignerStrategy {
    if (
      argv._[0] === 'warp' &&
      (argv._[1] === 'deploy' || argv._[1] === 'send')
    ) {
      return new WarpDeploySignerStrategy();
    }

    if (argv._[0] === 'send') {
      // You might want to create a specific multi-chain send strategy
      return new WarpDeploySignerStrategy();
    }

    return new SingleChainSignerStrategy();
  }
}

export async function getWarpDeployContext({
  configPath = DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
  skipConfirmation = false,
  context,
}: {
  configPath?: string;
  skipConfirmation?: boolean;
  context: any;
}): Promise<WarpDeployContextResult> {
  // Validate config path
  if (!configPath || !isFile(configPath)) {
    if (skipConfirmation) {
      throw new Error('Warp route deployment config is required');
    }

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
  const warpRouteConfig = await readWarpRouteDeployConfig(configPath, context);

  // Extract chains from configuration
  const chains = Object.keys(warpRouteConfig) as ChainName[];

  // Validate chains
  if (chains.length === 0) {
    throw new Error('No chains found in warp route deployment config');
  }

  // Optional: Confirm multi-chain deployment
  if (!skipConfirmation && chains.length > 1) {
    const confirmMultiChain = await confirm({
      message: `Deploy warp route across ${chains.length} chains: ${chains.join(
        ', ',
      )}?`,
      default: true,
    });

    if (!confirmMultiChain) {
      throw new Error('Deployment cancelled by user');
    }
  }

  return {
    warpRouteConfig,
    chains,
  };
}
