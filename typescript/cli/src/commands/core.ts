import { CommandModule } from 'yargs';

import {
  DeployedCoreAddresses,
  DeployedCoreAddressesSchema,
  EvmCoreReader,
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
import { errorRed, log, logGray, logGreen } from '../logger.js';
import {
  logYamlIfUnderMaxLines,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

import {
  chainCommandOption,
  dryRunCommandOption,
  fromAddressCommandOption,
  inputFileCommandOption,
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
  out: string;
}> = {
  command: 'apply',
  describe:
    'Applies onchain Core configuration updates for a given mailbox address',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    config: {
      ...inputFileCommandOption,
      default: './configs/core-config.yaml',
      description: 'The path to input a Core Config JSON or YAML file.',
    },
    out: outputFileCommandOption(
      undefined,
      false,
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({
    context,
    chain,
    config: configFilePath,
    out: coreConfigOutputFilePath,
  }) => {
    logGray(`Hyperlane Core Apply`);
    logGray('--------------------');

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

    if (coreConfigOutputFilePath) {
      writeYamlOrJson(coreConfigOutputFilePath, config, 'yaml');
      logGreen(
        `✅ Core deploy config written successfully to ${coreConfigOutputFilePath}:\n`,
      );
      logYamlIfUnderMaxLines(config);
    }
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
      './configs/core-config.yaml',
      false,
      'The path to output a Core Config JSON or YAML file.',
    ),
  },
  handler: async ({ context, chain, mailbox, config: configFilePath }) => {
    if (!mailbox) {
      const addresses = await context.registry.getChainAddresses(chain);
      mailbox = addresses?.mailbox;
      if (!mailbox) {
        throw new Error(
          `${chain} mailbox not provided and none found in registry ${context.registry.getUri()}`,
        );
      }
    }

    logGray('Hyperlane Core Read');
    logGray('-------------------');

    const evmCoreReader = new EvmCoreReader(context.multiProvider, chain);
    try {
      const coreConfig = await evmCoreReader.deriveCoreConfig(mailbox);
      writeYamlOrJson(configFilePath, coreConfig, 'yaml');
      logGreen(`✅ Core config written successfully to ${configFilePath}:\n`);
      logYamlIfUnderMaxLines(coreConfig);
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
