import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { runKurtosisAgentDeploy } from '../deploy/agent.js';
import { runCoreDeploy } from '../deploy/core.js';
import { evaluateIfDryRunFailure, verifyAnvil } from '../deploy/dry-run.js';
import { runWarpRouteDeploy } from '../deploy/warp.js';
import { log, logGray } from '../logger.js';

import {
  agentConfigCommandOption,
  agentTargetsCommandOption,
  coreTargetsCommandOption,
  dryRunOption,
  hookCommandOption,
  ismCommandOption,
  originCommandOption,
  warpConfigCommandOption,
} from './options.js';

export enum Command {
  DEPLOY = 'deploy',
  KURTOSIS_AGENTS = 'kurtosis-agents',
  CORE = 'core',
  WARP = 'warp',
}

/**
 * Parent command
 */
export const deployCommand: CommandModule = {
  command: Command.DEPLOY,
  describe: 'Permissionlessly deploy a Hyperlane contracts or extensions',
  builder: (yargs) =>
    yargs
      .command(coreCommand)
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
  command: Command.KURTOSIS_AGENTS,
  describe: 'Deploy Hyperlane agents with Kurtosis',
  builder: {
    origin: originCommandOption,
    targets: agentTargetsCommandOption,
    config: agentConfigCommandOption,
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
 * Core command
 */
const coreCommand: CommandModuleWithContext<{
  targets: string;
  ism?: string;
  hook?: string;
  'dry-run': boolean;
}> = {
  command: Command.CORE,
  describe: 'Deploy core Hyperlane contracts',
  builder: {
    targets: coreTargetsCommandOption,
    ism: ismCommandOption,
    hook: hookCommandOption,
    'dry-run': dryRunOption,
  },
  handler: async ({ context, targets, ism, hook, dryRun }) => {
    logGray(
      `Hyperlane permissionless core deployment${dryRun ? ' dry-run' : ''}`,
    );
    logGray('------------------------------------------------');

    if (dryRun) await verifyAnvil();

    try {
      const chains = targets?.split(',').map((r: string) => r.trim());
      await runCoreDeploy({
        context,
        chains,
        ismConfigPath: ism,
        hookConfigPath: hook,
        dryRun,
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
const warpCommand: CommandModuleWithContext<{
  config: string;
  'dry-run': boolean;
}> = {
  command: Command.WARP,
  describe: 'Deploy Warp Route contracts',
  builder: {
    config: warpConfigCommandOption,
    'dry-run': dryRunOption,
  },
  handler: async ({ context, config, dryRun }) => {
    logGray(`Hyperlane warp route deployment${dryRun ? ' dry-run' : ''}`);
    logGray('------------------------------------------------');

    if (dryRun) await verifyAnvil();

    try {
      await runWarpRouteDeploy({
        context,
        warpRouteDeploymentConfigPath: config,
        dryRun,
      });
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
    process.exit(0);
  },
};
