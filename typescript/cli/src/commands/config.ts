import { CommandModule } from 'yargs';

import { createChainConfig } from '../config/chain.js';
import { createMultisigConfig } from '../config/multisig.js';
import { readChainConfig, readMultisigConfig } from '../configs.js';
import { log } from '../logger.js';
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
  },
};
