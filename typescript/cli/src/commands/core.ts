import { CommandModule } from 'yargs';

import { CoreConfigSchema, EvmCoreReader, IsmConfig } from '@hyperlane-xyz/sdk';

import { createHookConfig } from '../config/hooks.js';
import { createIsmConfig, createTrustedRelayerConfig } from '../config/ism.js';
import { CommandModuleWithContext } from '../context/types.js';
import {
  log,
  logBlue,
  logBoldUnderlinedRed,
  logGray,
  logRed,
} from '../logger.js';
import { writeYamlOrJson } from '../utils/files.js';

import { deploy } from './deploy.js';
import { chainCommandOption, outputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Manage core Hyperlane contracts & configs',
  builder: (yargs) =>
    yargs
      .command(configure)
      .command(deploy)
      .command(read)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const configure: CommandModuleWithContext<{
  ismAdvanced: boolean;
  config: string;
}> = {
  command: 'configure',
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
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({ context, ismAdvanced, config: configFilePath }) => {
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
    IsmConfigSchema.parse(defaultIsm);
    HookConfigSchema.parse(requiredHook);
    HookConfigSchema.parse(defaultHook);

    writeYamlOrJson(configFilePath, { defaultIsm, defaultHook, requiredHook });

    process.exit(0);
  },
};

export const read: CommandModuleWithContext<{
  chain: string;
  mailbox: string;
  config: string;
}> = {
  command: 'read',
  describe: 'Reads onchain ISM & Hook configurations for given addresses',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    mailbox: {
      type: 'string',
      description: 'Mailbox address used to derive the core config',
      demandOption: true,
    },
    config: outputFileCommandOption(
      './configs/core-config.yaml',
      false,
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({ context, chain, mailbox, config: configFilePath }) => {
    logGray('Hyperlane Core Read');
    logGray('-------------------');

    const evmCoreReader = new EvmCoreReader(context.multiProvider, chain);
    const coreConfig = await evmCoreReader.deriveCoreConfig(mailbox);

    writeYamlOrJson(configFilePath, coreConfig);

    process.exit(0);
  },
};
