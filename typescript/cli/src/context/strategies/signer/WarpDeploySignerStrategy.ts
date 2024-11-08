import { confirm } from '@inquirer/prompts';

import {
  ChainName,
  ChainSubmissionStrategy,
  MultiProvider,
  TxSubmitterType,
} from '@hyperlane-xyz/sdk';

import { DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH } from '../../../commands/options.js';
import {
  isFile,
  readYamlOrJson,
  runFileSelectionStep,
} from '../../../utils/files.js';
import { ContextManager } from '../../manager/ContextManager.js';

import { SignerStrategy } from './SignerStrategy.js';

export interface WarpDeployContextResult {
  warpRouteConfig: Record<ChainName, any>;
  chains: ChainName[];
}

export class WarpDeploySignerStrategy implements SignerStrategy {
  async determineChains(argv: Record<string, any>): Promise<ChainName[]> {
    const configPath = argv.wd || DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH;
    const { chains } = await getWarpDeployContext({
      configPath,
      skipConfirmation: argv.skipConfirmation,
    });

    argv.context.config = configPath;
    argv.context.chains = chains;
    return chains;
  }

  createContextManager(
    chains: ChainName[],
    strategyConfig: ChainSubmissionStrategy,
    argv: any,
  ): ContextManager {
    return new ContextManager(
      strategyConfig,
      chains,
      TxSubmitterType.JSON_RPC,
      argv,
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

export async function getWarpDeployContext({
  configPath = DEFAULT_WARP_ROUTE_DEPLOYMENT_CONFIG_PATH,
  skipConfirmation = false,
}: {
  configPath?: string;
  skipConfirmation?: boolean;
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
  let warpRouteConfig = readYamlOrJson(configPath);
  if (!warpRouteConfig)
    throw new Error(`No warp route deploy config found at ${configPath}`);

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
