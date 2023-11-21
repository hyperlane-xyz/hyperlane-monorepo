import { CommandModule } from 'yargs';

import { log, logGray } from '../../logger.js';
import { runCoreDeploy } from '../deploy/core.js';
import { runWarpDeploy } from '../deploy/warp.js';

import {
  chainsCommandOption,
  coreArtifactsOption,
  keyCommandOption,
  outDirCommandOption,
  skipConfirmationOption,
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
  handler: () => log('Command required'),
};

/**
 * Core command
 */
const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Deploy core Hyperlane contracts',
  builder: (yargs) =>
    yargs.options({
      targets: {
        type: 'string',
        description:
          'Comma separated list of chain names to which contracts will be deployed',
      },
      chains: chainsCommandOption,
      artifacts: coreArtifactsOption,
      ism: {
        type: 'string',
        description:
          'A path to a JSON or YAML file with ISM configs (e.g. Multisig)',
      },
      hook: {
        type: 'string',
        description:
          'A path to a JSON or YAML file with Hook configs (for every chain)',
      },
      out: outDirCommandOption,
      key: keyCommandOption,
      yes: skipConfirmationOption,
    }),
  handler: async (argv: any) => {
    logGray('Hyperlane permissionless core deployment');
    logGray('----------------------------------------');
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const outPath: string = argv.out;
    const chains: string[] | undefined = argv.targets
      ?.split(',')
      .map((r: string) => r.trim());
    const artifactsPath: string = argv.artifacts;
    const ismConfigPath: string = argv.ism;
    const hookConfigPath: string = argv.hook;
    const skipConfirmation: boolean = argv.yes;
    await runCoreDeploy({
      key,
      chainConfigPath,
      chains,
      artifactsPath,
      ismConfigPath,
      hookConfigPath,
      outPath,
      skipConfirmation,
    });
    process.exit(0);
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
      config: {
        type: 'string',
        description: 'A path to a JSON or YAML file with a warp config.',
        default: './configs/warp-tokens.yaml',
      },
      core: coreArtifactsOption,
      chains: chainsCommandOption,
      out: outDirCommandOption,
      key: keyCommandOption,
      yes: skipConfirmationOption,
    }),
  handler: async (argv: any) => {
    const key: string = argv.key || process.env.HYP_KEY;
    const chainConfigPath: string = argv.chains;
    const warpConfigPath: string | undefined = argv.config;
    const coreArtifactsPath: string | undefined = argv.core;
    const outPath: string = argv.out;
    const skipConfirmation: boolean = argv.yes;
    await runWarpDeploy({
      key,
      chainConfigPath,
      warpConfigPath,
      coreArtifactsPath,
      outPath,
      skipConfirmation,
    });
    process.exit(0);
  },
};
