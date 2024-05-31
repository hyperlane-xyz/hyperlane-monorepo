import { CommandModule } from 'yargs';

import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { runKurtosisAgentDeploy } from '../deploy/agent.js';
import { runCoreDeploy, runCoreDeployLegacy } from '../deploy/core.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logGray } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import {
  agentConfigCommandOption,
  agentTargetsCommandOption,
  chainCommandOption,
  coreTargetsCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  hookCommandOption,
  ismCommandOption,
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
      .command(coreCommandLegacy)
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
 * Core command (Legacy)
 */
const coreCommandLegacy: CommandModuleWithWriteContext<{
  targets: string;
  ism?: string;
  hook?: string;
  'dry-run': string;
  'from-address': string;
  agent: string;
}> = {
  command: 'core',
  describe: 'Deploy core Hyperlane contracts',
  builder: {
    targets: coreTargetsCommandOption,
    ism: ismCommandOption,
    hook: hookCommandOption,
    agent: agentConfigCommandOption(false, './configs/agent.json'),
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
  },
  handler: async ({ context, targets, ism, hook, agent, dryRun }) => {
    logGray(
      `Hyperlane permissionless core deployment${dryRun ? ' dry-run' : ''}`,
    );
    logGray(`------------------------------------------------`);

    try {
      const chains = targets?.split(',').map((r: string) => r.trim());
      await runCoreDeployLegacy({
        context,
        chains,
        ismConfigPath: ism,
        hookConfigPath: hook,
        agentOutPath: agent,
      });
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
    process.exit(0);
  },
};

/**
 * Generates a command module for deploying Hyperlane contracts, given a command
 *
 * @param commandName - the deploy command key used to look up the deployFunction
 * @returns A command module used to deploy Hyperlane contracts.
 */
export const deployCore: CommandModuleWithWriteContext<{
  chain: string;
  config: string;
  dryRun: string;
  fromAddress: string;
}> = {
  command: 'deploy',
  describe: 'Deploy Hyperlane contracts',
  builder: {
    chain: {
      ...chainCommandOption,
    },
    config: {
      type: 'string',
      description:
        'The path to a JSON or YAML file with a core deployment config.',
      demandOption: true,
    },
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
  },
  handler: async ({ context, chain, config: configFilePath, dryRun }) => {
    logGray(`Hyperlane permissionless deployment${dryRun ? ' dry-run' : ''}`);
    logGray(`------------------------------------------------`);

    try {
      await runCoreDeploy({
        context,
        chain,
        config: readYamlOrJson(configFilePath),
      });
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
    process.exit(0);
  },
};

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
