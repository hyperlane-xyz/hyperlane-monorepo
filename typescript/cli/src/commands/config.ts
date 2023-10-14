import { CommandModule } from 'yargs';

import { log, logGreen } from '../../logger.js';
import { createChainConfig, readChainConfig } from '../config/chain.js';
import {
  createMultisigConfig,
  readMultisigConfig,
} from '../config/multisig.js';
import { createWarpConfig, readWarpRouteConfig } from '../config/warp.js';
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
      .command(createChainCommand)
      .command(createMultisigCommand)
      .command(createWarpCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

const createChainCommand: CommandModule = {
  command: 'chain',
  describe: 'Create a new, minimal Hyperlane chain config (aka chain metadata)',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/chain-config.yaml'),
      format: fileFormatOption,
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    await createChainConfig({ format, outPath });
    process.exit(0);
  },
};

const createMultisigCommand: CommandModule = {
  command: 'multisig',
  describe: 'Create a new Multisig ISM config',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/multisig-ism.yaml'),
      format: fileFormatOption,
      chains: chainsCommandOption,
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    const chainConfigPath: string = argv.chains;
    await createMultisigConfig({ format, outPath, chainConfigPath });
    process.exit(0);
  },
};

const createWarpCommand: CommandModule = {
  command: 'warp',
  describe: 'Create a new Warp Route tokens config',
  builder: (yargs) =>
    yargs.options({
      output: outputFileOption('./configs/warp-tokens.yaml'),
      format: fileFormatOption,
      chains: chainsCommandOption,
    }),
  handler: async (argv: any) => {
    const format: FileFormat = argv.format;
    const outPath: string = argv.output;
    const chainConfigPath: string = argv.chains;
    await createWarpConfig({ format, outPath, chainConfigPath });
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
      .command(validateMultisigCommand)
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
    readChainConfig(path);
    process.exit(0);
  },
};

const validateMultisigCommand: CommandModule = {
  command: 'multisig',
  describe: 'Validate a multisig ism config in a YAML or JSON file',
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
    readWarpRouteConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};
