import { CommandModule } from 'yargs';

import {
  DeployedCoreAddresses,
  DeployedCoreAddressesSchema,
} from '@hyperlane-xyz/sdk';

import {
  createCoreDeployConfig,
  readCoreDeployConfigs,
} from '../config/core.js';
import {
  CommandModuleWithContext,
  CommandModuleWithWriteContext,
} from '../context/types.js';
import { runCoreApply, runCoreDeploy } from '../deploy/core.js';
import { evaluateIfDryRunFailure } from '../deploy/dry-run.js';
import { log, logCommandHeader, logGreen } from '../logger.js';
import { executeCoreRead } from '../read/core.js';
import {
  logYamlIfUnderMaxLines,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

import {
  DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
  chainCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  outputFileCommandOption,
  skipConfirmationOption,
} from './options.js';

/**
 * Parent command
 */
export const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Manage core Hyperlane contracts & configs',
  builder: (yargs) =>
    yargs
      .command(apply)
      .command(deploy)
      .command(init)
      .command(read)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const apply: CommandModuleWithWriteContext<{
  chain: string;
  config: string;
}> = {
  command: 'apply',
  describe:
    'Applies onchain Core configuration updates for a given mailbox address',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    config: outputFileCommandOption(
      DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
      true,
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({ context, chain, config: configFilePath }) => {
    logCommandHeader(`Hyperlane Core Apply`);

    const addresses = (await context.registry.getChainAddresses(
      chain,
    )) as DeployedCoreAddresses;
    DeployedCoreAddressesSchema.parse(addresses);

    const config = await readCoreDeployConfigs(configFilePath);

    await runCoreApply({
      context,
      chain,
      config,
      deployedCoreAddresses: addresses,
    });
    process.exit(0);
  },
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
      DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
      false,
      'The path to a JSON or YAML file with a core deployment config.',
    ),
    'dry-run': dryRunCommandOption,
    'from-address': fromAddressCommandOption,
    'skip-confirmation': skipConfirmationOption,
  },
  handler: async ({ context, chain, config: configFilePath, dryRun }) => {
    logCommandHeader(`Hyperlane Core deployment${dryRun ? ' dry-run' : ''}`);

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
      DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
      false,
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({ context, advanced, config: configFilePath }) => {
    logCommandHeader('Hyperlane Core Configure');

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
  config: string;
  mailbox?: string;
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
    },
    config: outputFileCommandOption(
      DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
      false,
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({ context, chain, mailbox, config: configFilePath }) => {
    logCommandHeader('Hyperlane Core Read');

    const coreConfig = executeCoreRead({ context, chain, mailbox });

    writeYamlOrJson(configFilePath, coreConfig, 'yaml');
    logGreen(`✅ Core config written successfully to ${configFilePath}:\n`);
    logYamlIfUnderMaxLines(coreConfig);

    process.exit(0);
  },
};
