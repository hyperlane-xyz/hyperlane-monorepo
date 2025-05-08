import { CommandModule } from 'yargs';

import { readChainConfigs } from '../config/chain.js';
import { readIsmConfig } from '../config/ism.js';
import { readMultisigConfig } from '../config/multisig.js';
import { readChainSubmissionStrategyConfig } from '../config/strategy.js';
import { readWarpRouteDeployConfig } from '../config/warp.js';
import { CommandModuleWithContext } from '../context/types.js';
import { log, logGreen } from '../logger.js';

import { inputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const configCommand: CommandModule = {
  command: 'config',
  describe: 'Create or validate Hyperlane configs',
  builder: (yargs) =>
    yargs.command(validateCommand).version(false).demandCommand(),
  handler: () => log('Command required'),
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
      .command(validateStrategyCommand)
      .command(validateWarpCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

const validateChainCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'chain',
  describe: 'Validate a chain config file',
  builder: {
    path: inputFileCommandOption(),
  },
  handler: async ({ path }) => {
    readChainConfigs(path);
    logGreen(`All chain configs in ${path} are valid`);
    process.exit(0);
  },
};

const validateIsmCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'ism',
  describe: 'Validate the basic ISM config file',
  builder: {
    path: inputFileCommandOption(),
  },
  handler: async ({ path }) => {
    readMultisigConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};

const validateIsmAdvancedCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'ism-advanced',
  describe: 'Validate the advanced ISM config file',
  builder: {
    path: inputFileCommandOption(),
  },
  handler: async ({ path }) => {
    readIsmConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};

const validateStrategyCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'strategy',
  describe: 'Validates a Strategy config file',
  builder: {
    path: inputFileCommandOption(),
  },
  handler: async ({ path }) => {
    await readChainSubmissionStrategyConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};

const validateWarpCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'warp',
  describe: 'Validate a Warp Route deployment config file',
  builder: {
    path: inputFileCommandOption(),
  },
  handler: async ({ path, context }) => {
    await readWarpRouteDeployConfig({ filePath: path, context });
    logGreen('Config is valid');
    process.exit(0);
  },
};
