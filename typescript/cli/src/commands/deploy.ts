import { CommandModule, Options } from 'yargs';

import { runCoreDeploy } from '../deploy/core.js';
import { runWarpDeploy } from '../deploy/warp.js';
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

const commonOptions: { [key: string]: Options } = {
  key: {
    type: 'string',
    description:
      'A hex private key or seed phrase for transaction signing. Or use the HYP_KEY env var',
  },
  out: {
    type: 'string',
    description: 'A folder name output artifacts into.',
    default: './artifacts',
  },
};

/**
 * Core command
 */
const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Deploy core Hyperlane contracts',
  builder: (yargs) =>
    yargs.options({
      ...commonOptions,
      config: {
        type: 'string',
        description: 'A path to a JSON or YAML file with chain configs.',
        default: './configs/chain-config.yaml',
      },
    }),
  handler: (argv: any) => {
    logGray('Hyperlane permissionless core deployment');
    logGray('----------------------------------------');
    const key: string = argv.key || process.env.HYP_KEY;
    const configPath: string = argv.config;
    const outPath: string = argv.out;
    return runCoreDeploy({ key, configPath, outPath });
  },
};

/**
 * Warp command
 */
const warpCommand: CommandModule = {
  command: 'warp',
  describe: 'Deploy Warp Route contracts',
  builder: (yargs) =>
    yargs.options({
      ...commonOptions,
      config: {
        type: 'string',
        description: 'A path to a JSON or YAML file with a warp config.',
        default: './configs/warp-tokens.yaml',
      },
      core: {
        type: 'string',
        description: 'File path to core deployment output artifacts',
      },
    }),
  handler: (argv: any) => {
    const key: string = argv.key || process.env.HYP_KEY;
    const configPath: string = argv.config;
    const corePath: string = argv.core;
    const outPath: string = argv.out;
    return runWarpDeploy({ key, configPath, corePath, outPath });
  },
};
