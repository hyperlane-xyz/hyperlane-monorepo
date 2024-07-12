import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import { EvmCoreReader } from '@hyperlane-xyz/sdk';

import { createCoreDeployConfig } from '../config/core.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { runCoreDeploy } from '../deploy/core.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { errorRed, log, logGray, logGreen } from '../logger.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

import {
  chainCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
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
      .command(init)
      .command(read)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Generates a command module for deploying Hyperlane contracts, given a command
 *
 * @param commandName - the deploy command key used to look up the deployFunction
 * @returns A command module used to deploy Hyperlane contracts.
 */
export const deploy: CommandModuleWithWriteContext<{
  chain: string;
  config: string;
  dryRun: string;
  fromAddress: string;
}> = {
  command: 'deploy',
  describe: 'Deploy Hyperlane contracts',
  builder: {
    chain: chainCommandOption,
    config: outputFileCommandOption(
      './configs/core-config.yaml',
      false,
      'The path to a JSON or YAML file with a core deployment config.',
    ),
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
  },
  handler: async ({ context, chain, config: configFilePath, dryRun }) => {
    logGray(`Hyperlane permissionless deployment${dryRun ? ' dry-run' : ''}`);
    logGray(`------------------------------------------------`);

    try {
      await runCoreDeploy({
        context,
        chain,
        config: readYamlOrJson(configFilePath),
      });
    } catch (error: any) {
      evaluateIfDryRunFailure(error, dryRun);
      throw error;
    }
    process.exit(0);
  },
};

export const init: CommandModuleWithContext<{
  advanced: boolean;
  config: string;
}> = {
  command: 'init',
  describe: 'Create a core configuration, including ISMs and hooks.',
  builder: {
    advanced: {
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
  handler: async ({ context, advanced, config: configFilePath }) => {
    logGray('Hyperlane Core Configure');
    logGray('------------------------');

    await createCoreDeployConfig({
      context,
      configFilePath,
      advanced,
    });

    process.exit(0);
  },
};

export const read: CommandModuleWithContext<{
  chain: string;
  mailbox: string;
  config: string;
}> = {
  command: 'read',
  describe: 'Reads onchain Core configuration for a given mailbox address',
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
    try {
      const coreConfig = await evmCoreReader.deriveCoreConfig(mailbox);
      writeYamlOrJson(configFilePath, coreConfig, 'yaml');
      logGreen(`✅ Core config written successfully to ${configFilePath}:\n`);
      log(indentYamlOrJson(yamlStringify(coreConfig, null, 2), 4));
    } catch (e: any) {
      errorRed(
        `❌ Failed to read core config for mailbox ${mailbox} on ${chain}:`,
        e,
      );
      process.exit(1);
    }

    process.exit(0);
  },
};
