import { CommandModule } from 'yargs';

import { runCoreDeploy } from '../deploy/core.js';
import { logGray } from '../logger.js';

/**
 * Parent command
 */
export const deployCommand: CommandModule = {
  command: 'deploy',
  describe: 'Permisionslessly deploy a Hyperlane contracts or extensions',
  builder: (yargs) =>
    yargs
      .command(coreCommand)
      .command(warpCommand)
      .version(false)
      .demandCommand(),
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
      key: {
        type: 'string',
        description:
          'A hex private key or seed phrase for transaction signing. Or use the HYP_KEY env var',
      },
      config: {
        type: 'string',
        description:
          'A path to a JSON or YAML file with chain configs. Defaults to ./configs/chain-config.yaml',
      },
      out: {
        type: 'string',
        description:
          'A folder name output artifacts into. Defaults to ./artifacts',
      },
    }),
  handler: (argv: any) => {
    logGray('Hyperlane permissionless core deployment');
    logGray('----------------------------------------');
    const key: string = argv.key || process.env.HYP_KEY;
    const configPath: string = argv.config || './configs/chain-config.yaml';
    const outPath: string = argv.out || './artifacts/';
    return runCoreDeploy({ key, configPath, outPath });
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
