import { CommandModule } from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';

import { CRUD_COMMANDS } from '../consts.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
  WriteCommandContext,
} from '../context/types.js';
import { runKurtosisAgentDeploy } from '../deploy/agent.js';
import { deployCore } from '../deploy/core.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logBlue, logGray } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import { CORE_COMMAND } from './core.js';
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

export const DEPLOY_COMMAND = 'deploy';

/// @remark Mapping of top level command to deploy functions
const deployFunctions: Record<string, (params: any) => Promise<any>> = {
  [CORE_COMMAND]: deployCore,
  // warp: deployWarp
};

/**
 * Generates a command module for deploying Hyperlane contracts, given a command
 *
 * @param commandName - the deploy command key used to look up the deployFunction
 * @returns A command module used to deploy Hyperlane contracts.
 */
export function deploy(commandName: string): CommandModuleWithWriteContext<{
  config: string;
  chain: string;
  dryRun: string;
}> {
  return {
    command: DEPLOY_COMMAND,
    describe: 'Deploy Hyperlane contracts',
    builder: {
      chain: {
        type: 'string',
        description: 'The name of a single chain to deploy to',
      },
      config: {
        type: 'string',
        description:
          'The path to a JSON or YAML file with a deployment config.',
        demandOption: true,
      },
      'dry-run': dryRunCommandOption,
    },
    handler: async ({ context, chain, config: configFilePath, dryRun }) => {
      logGray(`Hyperlane permissionless deployment${dryRun ? ' dry-run' : ''}`);
      logGray(`------------------------------------------------`);

      try {
        logBlue('All systems ready, captain! Beginning deployment...');

        await deployFunctions[commandName]({
          context,
          chain,
          config: readYamlOrJson(configFilePath),
        });

        logBlue('Deployment is complete!');
      } catch (error: any) {
        evaluateIfDryRunFailure(error, dryRun);
        throw error;
      }
      process.exit(0);
    },
  };
}

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
