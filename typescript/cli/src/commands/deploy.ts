import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { CommandModule } from 'yargs';

/**
 * Parent command
 */
export const deployCommand: CommandModule = {
  command: 'deploy',
  describe: 'Permisionslessly deploy a Hyperlane contracts or extensions',
  builder: (yargs) =>
    yargs.command(coreCommand).command(warpCommand).demandCommand(),
  handler: () => console.log('Command required'),
};

/**
 * Core command
 */
const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Deploy core Hyperlane contracts',
  builder: (yargs) =>
    yargs.options({
      local: {
        type: 'string',
        description: 'The chain to deploy to',
        demandOption: true,
      },
      remotes: {
        type: 'string',
        array: true,
        description:
          'The chains with which local will send and receive messages',
        demandOption: true,
      },
      key: {
        type: 'string',
        description:
          'A hexadecimal private key or seed phrase for transaction signing',
        demandOption: true,
      },
      config: {
        type: 'string',
        description:
          'A path to a JSON or YAML file with the chain configs. See ./examples/deploy_core_config.yml for an example.',
        demandOption: true,
      },
    }),
  handler: async (_argv) => {
    console.log(chalk.blue('Hyperlane permissionless core deployment'));
    console.log(chalk.gray('----------------------------------------'));
    const confirmation = await confirm({ message: 'Are you sure?' });
    if (!confirmation) throw new Error('Deployment cancelled');
  },
};

/**
 * Warp command
 */
const warpCommand: CommandModule = {
  command: 'warp',
  describe: 'Deploy Warp Route contracts',
  builder: (yargs) => yargs.options({}),
  handler: (_args) => {
    // TODO
  },
};
