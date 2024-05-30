import { CommandModule } from 'yargs';

import { ChainName, HyperlaneAddresses } from '@hyperlane-xyz/sdk';

import { CRUD_COMMANDS } from '../consts.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
  WriteCommandContext,
} from '../context/types.js';
import { runKurtosisAgentDeploy } from '../deploy/agent.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logBlue, logGray } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

import {
  agentConfigCommandOption,
  agentTargetsCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  originCommandOption,
  warpDeploymentConfigCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const deployCommand: CommandModule = {
  command: 'deploy',
  describe: 'Permissionlessly deploy a Hyperlane contracts or extensions',
  builder: (yargs) =>
    yargs
      .command(warpCommand)
      .command(agentCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Agent command
 */
const agentCommand: CommandModuleWithContext<{
  origin?: string;
  targets?: string;
  config?: string;
}> = {
  command: 'kurtosis-agents',
  describe: 'Deploy Hyperlane agents with Kurtosis',
  builder: {
    origin: originCommandOption,
    targets: agentTargetsCommandOption,
    config: agentConfigCommandOption(true),
  },
  handler: async ({ context, origin, targets, config }) => {
    logGray('Hyperlane Agent Deployment with Kurtosis');
    logGray('----------------------------------------');
    await runKurtosisAgentDeploy({
      context,
      originChain: origin,
      relayChains: targets,
      agentConfigurationPath: config,
    });
    process.exit(0);
  },
};

/**
 * Generates a command module for deploying Hyperlane contracts.
 *
 * @param deployFunction - A function that performs the actual deployment
 * @returns A command module used to deploy Hyperlane contracts.
 */
export const deployWith = (
  deployFunction: (params: {
    context: WriteCommandContext;
    chain: ChainName;
    configFilePath: string;
  }) => Promise<HyperlaneAddresses<any>>,
): CommandModuleWithWriteContext<{
  config: string;
  chain: string;
  dryRun: string;
}> => ({
  command: CRUD_COMMANDS.DEPLOY,
  describe: 'Deploy Hyperlane contracts',
  builder: {
    config: {
      type: 'string',
      description: 'The path to a JSON or YAML file with a deployment config.',
      demandOption: true,
    },
    chain: {
      type: 'string',
      description: 'The name of a single chain to deploy to',
    },
    'dry-run': dryRunCommandOption,
  },
  handler: async ({ context, chain, config: configFilePath, dryRun }) => {
    const { chainMetadata, isDryRun, dryRunChain, registry, skipConfirmation } =
      context;

    logGray(`Hyperlane permissionless deployment${dryRun ? ' dry-run' : ''}`);
    logGray(`------------------------------------------------`);

    // Select a dry-run chain if it's not supplied
    if (dryRunChain) {
      chain = dryRunChain;
    } else if (!chain) {
      if (skipConfirmation) throw new Error('No chain provided');
      chain = await runSingleChainSelectionStep(
        chainMetadata,
        'Select chain to connect:',
      );
    }

    // Deploy and update Registry
    try {
      logBlue('All systems ready, captain! Beginning deployment...');

      const deployedAddresses = await deployFunction({
        context,
        chain,
        configFilePath,
      });

      if (!isDryRun) {
        await registry.updateChain({
          chainName: chain,
          addresses: deployedAddresses,
        });
      }

      logBlue('Deployment is complete!');
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
    process.exit(0);
  },
});

/**
 * Warp command
 */
const warpCommand: CommandModuleWithWriteContext<{
  config: string;
  'dry-run': string;
  'from-address': string;
}> = {
  command: 'warp',
  describe: 'Deploy Warp Route contracts',
  builder: {
    config: warpDeploymentConfigCommandOption,
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
  },
  handler: async ({ context, config, dryRun }) => {
    logGray(`Hyperlane warp route deployment${dryRun ? ' dry-run' : ''}`);
    logGray('------------------------------------------------');

    try {
      await runWarpRouteDeploy({
        context,
        warpRouteDeploymentConfigPath: config,
      });
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
    process.exit(0);
  },
};
