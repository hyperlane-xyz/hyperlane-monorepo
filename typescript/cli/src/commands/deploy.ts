import { CommandModule } from 'yargs';

import { runCoreDeploy } from '../deploy/core.js';
import { runWarpDeploy } from '../deploy/warp.js';
import { logGray } from '../logger.js';

import {
  chainsCommandOption,
  keyCommandOption,
  outDirCommandOption,
} from './options.js';

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
      key: keyCommandOption,
      chains: chainsCommandOption,
      out: outDirCommandOption,
    }),
  handler: async (argv: any) => {
    logGray('Hyperlane permissionless core deployment');
    logGray('----------------------------------------');
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const outPath: string = argv.out;
    await runCoreDeploy({ key, chainConfigPath, outPath });
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
      key: keyCommandOption,
      chains: chainsCommandOption,
      out: outDirCommandOption,
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
  handler: async (argv: any) => {
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const warpConfigPath: string = argv.config;
    const corePath: string = argv.core;
    const outPath: string = argv.out;
    await runWarpDeploy({
      key,
      chainConfigPath,
      warpConfigPath,
      corePath,
      outPath,
    });
  },
};
