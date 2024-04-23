import { CommandModule } from 'yargs';

import { createChainConfig } from '../config/chain.js';
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
import { CommandModuleWithContext } from '../context/types.js';
import { log, logGreen } from '../logger.js';

import { inputFileOption, outputFileOption } from './options.js';

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

const createChainConfigCommand: CommandModuleWithContext<{}> = {
  command: 'chain',
  describe: 'Create a new, minimal Hyperlane chain config (aka chain metadata)',
  handler: async ({ context }) => {
    await createChainConfig({ context });
    process.exit(0);
  },
};

const createIsmConfigCommand: CommandModuleWithContext<{
  out: string;
  advanced: boolean;
}> = {
  command: 'ism',
  describe: 'Create a basic or advanced ISM config for a validator set',
  builder: {
    out: outputFileOption('./configs/ism.yaml'),
    advanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM configuration',
      default: false,
    },
  },
  handler: async ({ out, advanced, context }) => {
    if (advanced) {
      await createIsmConfigMap({ outPath: out, context });
    } else {
      await createMultisigConfig({ outPath: out, context });
    }
    process.exit(0);
  },
};

const createHookConfigCommand: CommandModuleWithContext<{ out: string }> = {
  command: 'hooks',
  describe: 'Create a new hooks config (required & default)',
  builder: {
    out: outputFileOption('./configs/hooks.yaml'),
  },
  handler: async ({ out, context }) => {
    await createHooksConfigMap({ outPath: out, context });
    process.exit(0);
  },
};

const createWarpRouteDeployConfigCommand: CommandModuleWithContext<{
  out: string;
}> = {
  command: 'warp',
  describe: 'Create a new Warp Route deployment config',
  builder: {
    out: outputFileOption('./configs/warp-route-deployment.yaml'),
  },
  handler: async ({ out, context }) => {
    await createWarpRouteDeployConfig({ outPath: out, context });
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

const validateChainCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'chain',
  describe: 'Validate a chain config file',
  builder: {
    path: inputFileOption,
  },
  handler: async ({ path }) => {
    //TODO
    readChainConfigs(path);
    process.exit(0);
  },
};

const validateIsmCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'ism',
  describe: 'Validate the basic ISM config file',
  builder: {
    path: inputFileOption,
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
    path: inputFileOption,
  },
  handler: async ({ path }) => {
    readIsmConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};

const validateWarpCommand: CommandModuleWithContext<{ path: string }> = {
  command: 'warp',
  describe: 'Validate a Warp Route deployment config file',
  builder: {
    path: inputFileOption,
  },
  handler: async ({ path }) => {
    readWarpRouteDeployConfig(path);
    logGreen('Config is valid');
    process.exit(0);
  },
};
