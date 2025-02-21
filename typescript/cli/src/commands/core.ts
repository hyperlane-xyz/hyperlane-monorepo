import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import {
  CoreConfig,
  DeployedCoreAddresses,
  DeployedCoreAddressesSchema,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { diffObjMerge } from '@hyperlane-xyz/utils';

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
import { formatYamlViolationsOutput } from '../utils/output.js';

import {
  DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
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
      .command(check)
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

    const config = readCoreDeployConfigs(configFilePath);

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
  },
  handler: async ({
    context,
    chain,
    config: configFilePath,
    dryRun,
    multiProtocolSigner,
  }) => {
    logCommandHeader(`Hyperlane Core deployment${dryRun ? ' dry-run' : ''}`);

    try {
      await runCoreDeploy({
        context,
        chain,
        config: readYamlOrJson(configFilePath),
        multiProtocolSigner,
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
  interchainAccountRouter?: string;
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

    const coreConfig = await executeCoreRead({
      context,
      chain,
      mailbox,
    });

    writeYamlOrJson(configFilePath, coreConfig, 'yaml');
    logGreen(`✅ Core config written successfully to ${configFilePath}:\n`);
    logYamlIfUnderMaxLines(coreConfig);

    process.exit(0);
  },
};

export const check: CommandModuleWithContext<{
  chain: string;
  config: string;
  mailbox?: string;
}> = {
  command: 'check',
  describe:
    'Reads onchain Core configuration for a given mailbox address and compares it with a provided file',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    mailbox: {
      type: 'string',
      description:
        'Mailbox address used to derive the core config. If not provided it will be inferred from the registry',
    },
    config: inputFileCommandOption({
      defaultPath: DEFAULT_CORE_DEPLOYMENT_CONFIG_PATH,
      description: 'The path to a Core Config JSON or YAML file.',
      demandOption: false,
    }),
  },
  handler: async ({ context, chain, mailbox, config: configFilePath }) => {
    logCommandHeader('Hyperlane Core Check');

    const expectedCoreConfig: CoreConfig = await readYamlOrJson(configFilePath);
    const onChainCoreConfig = await executeCoreRead({
      context,
      chain,
      mailbox,
    });

    const { mergedObject, isInvalid } = diffObjMerge(
      normalizeConfig(onChainCoreConfig),
      normalizeConfig(expectedCoreConfig),
    );

    if (isInvalid) {
      log(formatYamlViolationsOutput(yamlStringify(mergedObject, null, 2)));
      process.exit(1);
    }

    logGreen(`No violations found`);

    process.exit(0);
  },
};
