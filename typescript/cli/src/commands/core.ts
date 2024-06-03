import { CommandModule } from 'yargs';

import { HookConfigSchema, IsmConfig } from '@hyperlane-xyz/sdk';

import { createHookConfig } from '../config/hooks.js';
import { createIsmConfig, createTrustedRelayerConfig } from '../config/ism.js';
import { CommandModuleWithContext } from '../context/types.js';
import { readHookConfig } from '../hook/read.js';
import { readIsmConfig } from '../ism/read.js';
import {
  log,
  logBlue,
  logBoldUnderlinedRed,
  logGray,
  logRed,
  warnYellow,
} from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';

import { deploy } from './deploy.js';
import {
  addressCommandOption,
  chainCommandOption,
  outputFileCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Manage core Hyperlane contracts & configs',
  builder: (yargs) =>
    yargs
      .command(deploy)
      .command(config)
      .command(read)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const config: CommandModuleWithContext<{
  ismAdvanced: boolean;
  config: string;
}> = {
  command: 'config',
  describe: 'Create a core configuration, including ISMs and hooks.',
  builder: {
    ismAdvanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM & hook configuration',
      default: false,
    },
    config: outputFileCommandOption(
      './configs/core-config.yaml',
      false,
      'The path to a JSON or YAML file with a core deployment config.',
    ),
  },
  handler: async ({ context, ismAdvanced, config }) => {
    logGray('Hyperlane Core Configure');
    logGray('------------------------');

    // Create default Ism config (advanced or trusted)
    let defaultIsm: IsmConfig;
    if (ismAdvanced) {
      logBlue('Creating a new advanced ISM config');
      logBoldUnderlinedRed('WARNING: USE AT YOUR RISK.');
      logRed(
        'Advanced ISM configs require knowledge of different ISM types and how they work together topologically. If possible, use the basic ISM configs are recommended.',
      );
      defaultIsm = await createIsmConfig(context);
    } else {
      defaultIsm = await createTrustedRelayerConfig(context);
    }

    // Create default and required Hook config
    const defaultHook = await createHookConfig(
      context,
      'Select default hook type',
    );
    const requiredHook = await createHookConfig(
      context,
      'Select required hook type',
    );

    // Validate
    HookConfigSchema.parse(requiredHook);
    HookConfigSchema.parse(defaultHook);

    writeYamlOrJson(config, { defaultIsm, defaultHook, requiredHook });

    process.exit(0);
  },
};

export const read: CommandModuleWithContext<{
  chain: string;
  ismAddress: string;
  hookAddress: string;
  ismOut: string;
  hookOut: string;
}> = {
  command: 'read',
  describe: 'Reads onchain ISM & Hook configurations for given addresses',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    ismAddress: addressCommandOption(
      'Address of the Interchain Security Module to read.',
      false,
    ),
    hookAddress: addressCommandOption('Address of the Hook to read.', false),
    ismOut: outputFileCommandOption(),
    hookOut: outputFileCommandOption(),
  },
  handler: async ({
    context,
    chain,
    ismAddress,
    hookAddress,
    ismOut,
    hookOut,
  }) => {
    logGray('Hyperlane Core Read');
    logGray('-------------------');

    if (ismAddress)
      await readIsmConfig({
        context,
        chain,
        address: ismAddress,
        out: ismOut,
      });
    if (hookAddress)
      await readHookConfig({
        context,
        chain,
        address: hookAddress,
        out: hookOut,
      });

    if (!ismAddress && !hookAddress)
      warnYellow(
        'Must provide --ism-address, --hook-address, or both to read.',
      );
    process.exit(0);
  },
};
