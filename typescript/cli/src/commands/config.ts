import { CommandModule } from 'yargs';

import { createChainConfig, readChainConfigs } from '../config/chain.js';
import { createHooksConfigMap } from '../config/hooks.js';
import { createIsmConfigMap, readIsmConfig } from '../config/ism.js';
import {
  createMultisigConfig,
  readMultisigConfig,
} from '../config/multisig.js';
import {
  createWarpRouteDeployConfig,
  readWarpRouteDeployConfig,
} from '../config/warp.js';
import { log, logGreen } from '../logger.js';
import { FileFormat } from '../utils/files.js';

import {
  chainsCommandOption,
  fileFormatOption,
  outputFileOption,
} from './options.js';

/**
 * Parent command
 */
export const configCommand: CommandModule = {
  command: 'config',
  describe: 'Create or validate Hyperlane configs',
  builder: (yargs) =>
    yargs
      .command(createCommand)
      .command(validateCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Create commands
 */
const createCommand: CommandModule = {
  command: 'create',
  describe: 'Create a new Hyperlane config',
  builder: (yargs) =>
    yargs
      .command(createChainConfigCommand)
      .command(createIsmConfigCommand)
      .command(createHookConfigCommand)
      .command(createWarpRouteDeployConfigCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

const createChainConfigCommand: CommandModule = {
  command: 'chain',
  describe: 'Create a new, minimal Hyperlane chain config (aka chain metadata)',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/chains.yaml'),
      format: fileFormatOption,
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    await createChainConfig({ format, outPath });
    process.exit(0);
  },
};

const createIsmConfigCommand: CommandModule = {
  command: 'ism',
  describe: 'Create a basic or advanced ISM config for a validator set',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/ism.yaml'),
      format: fileFormatOption,
      chains: chainsCommandOption,
      advanced: {
        type: 'boolean',
        describe: 'Create an advanced ISM configuration',
        default: false,
      },
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    const chainConfigPath: string = argv.chains;
    const isAdvanced: boolean = argv.advanced;

    if (isAdvanced) {
      await createIsmConfigMap({ format, outPath, chainConfigPath });
    } else {
      await createMultisigConfig({ format, outPath, chainConfigPath });
    }

    process.exit(0);
  },
};

const createHookConfigCommand: CommandModule = {
  command: 'hooks',
  describe: 'Create a new hooks config (required & default)',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/hooks.yaml'),
      format: fileFormatOption,
      chains: chainsCommandOption,
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    const chainConfigPath: string = argv.chains;
    await createHooksConfigMap({ format, outPath, chainConfigPath });
    process.exit(0);
  },
};

const createWarpRouteDeployConfigCommand: CommandModule = {
  command: 'warp',
  describe: 'Create a new Warp Route deployment config',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/warp-route-deployment.yaml'),
      format: fileFormatOption,
      chains: chainsCommandOption,
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    const chainConfigPath: string = argv.chains;
    await createWarpRouteDeployConfig({ format, outPath, chainConfigPath });
    process.exit(0);
  },
};

/**
 * Validate commands
 */
const validateCommand: CommandModule = {
  command: 'validate',
  describe: 'Validate a config in a YAML or JSON file',
  builder: (yargs) =>
    yargs
      .command(validateChainCommand)
      .command(validateIsmCommand)
      .command(validateIsmAdvancedCommand)
      .command(validateWarpCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

const validateChainCommand: CommandModule = {
  command: 'chain',
  describe: 'Validate a chain config in a YAML or JSON file',
  builder: (yargs) =>
    yargs.options({
      path: {
        type: 'string',
        description: 'Input file path',
        demandOption: true,
      },
    }),
  handler: async (argv) => {
    const path = argv.path as string;
    readChainConfigs(path);
    process.exit(0);
  },
};

const validateIsmCommand: CommandModule = {
  command: 'ism',
  describe: 'Validate the basic ISM config in a YAML or JSON file',
  builder: (yargs) =>
    yargs.options({
      path: {
        type: 'string',
        description: 'Input file path',
        demandOption: true,
      },
    }),
  handler: async (argv) => {
    const path = argv.path as string;
    readMultisigConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};

const validateIsmAdvancedCommand: CommandModule = {
  command: 'ism-advanced',
  describe: 'Validate the advanced ISM config in a YAML or JSON file',
  builder: (yargs) =>
    yargs.options({
      path: {
        type: 'string',
        description: 'Input file path',
        demandOption: true,
      },
    }),
  handler: async (argv) => {
    const path = argv.path as string;
    readIsmConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};

const validateWarpCommand: CommandModule = {
  command: 'warp',
  describe: 'Validate a Warp Route config in a YAML or JSON file',
  builder: (yargs) =>
    yargs.options({
      path: {
        type: 'string',
        description: 'Input file path',
        demandOption: true,
      },
    }),
  handler: async (argv) => {
    const path = argv.path as string;
    readWarpRouteDeployConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};
