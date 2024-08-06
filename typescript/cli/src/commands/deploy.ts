import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { runKurtosisAgentDeploy } from '../deploy/agent.js';
import { log, logGray } from '../logger.js';

import {
  agentConfigCommandOption,
  agentTargetsCommandOption,
  originCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const deployCommand: CommandModule = {
  command: 'deploy',
  describe: 'Permissionlessly deploy a Hyperlane contracts or extensions',
  builder: (yargs) =>
    yargs.command(agentCommand).version(false).demandCommand(),
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
