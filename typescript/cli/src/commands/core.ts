import { CommandModule } from 'yargs';

import { createHooksConfigMap } from '../config/hooks.js';
import { createIsmConfigMap } from '../config/ism.js';
import { CommandModuleWithContext } from '../context/types.js';
import { readHookConfig } from '../hook/read.js';
import { readIsmConfig } from '../ism/read.js';
import { log, warnYellow } from '../logger.js';
import { deployCoreCommand } from './deploy.js';

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
      .command(deployCoreCommand)
      .command(config)
      .command(read)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const config: CommandModuleWithContext<{
  ismAdvanced: boolean;
  ismOut: string;
  hooksOut: string;
}> = {
  command: 'config',
  describe: 'Create a core configuration, including ISMs and hooks.',
  builder: {
    ismAdvanced: {
      type: 'boolean',
      describe: 'Create an advanced ISM & hook configuration',
      default: false,
    },
    ismOut: outputFileCommandOption('./configs/ism.yaml'),
    hooksOut: outputFileCommandOption('./configs/hooks.yaml'),
  },
  handler: async ({ context, ismAdvanced, ismOut, hooksOut }) => {
    await createIsmConfigMap({
      context,
      outPath: ismOut,
      shouldUseDefault: !ismAdvanced,
    });
    await createHooksConfigMap({
      context,
      outPath: hooksOut,
    });

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
