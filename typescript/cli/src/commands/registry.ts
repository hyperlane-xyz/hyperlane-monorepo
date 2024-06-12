import { Argv, CommandModule } from 'yargs';

import { createAgentConfig } from '../config/agent.js';
import { CommandContext, CommandModuleWithContext } from '../context/types.js';
import { log, logBlue, logGray, logRed, logTable } from '../logger.js';

import {
  chainTargetsCommandOption,
  environmentCommandOption,
  outputFileCommandOption,
} from './options.js';
import { ChainType, ChainTypes } from './types.js';

/**
 * Parent command
 */
export const registryCommand: CommandModule = {
  command: 'registry',
  describe: 'View information about Hyperlane chains in a registry',
  builder: (yargs) =>
    yargs
      .command(listCommand)
      .command(addressesCommand)
      .command(createAgentConfigCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * List command
 */
const listCommand: CommandModuleWithContext<{ type: ChainType }> = {
  command: 'list',
  describe: 'List all chains included in a registry',
  builder: {
    type: {
      describe: 'Specify the type of chains',
      choices: ChainTypes,
    },
  },
  handler: async ({ type, context }) => {
    const logChainsForType = (type: ChainType) => {
      logBlue(`\nHyperlane ${type} chains:`);
      logGray('------------------------------');
      const chains = Object.values(context.chainMetadata).filter((c) => {
        if (type === 'mainnet') return !c.isTestnet;
        else return !!c.isTestnet;
      });
      const tableData = chains.reduce<any>((result, chain) => {
        const { chainId, displayName } = chain;
        result[chain.name] = {
          'Display Name': displayName,
          'Chain Id': chainId,
        };
        return result;
      }, {});
      logTable(tableData);
    };

    if (type) {
      logChainsForType(type);
    } else {
      logChainsForType('mainnet');
      logChainsForType('testnet');
    }
  },
};

/**
 * Addresses command
 */
const addressesCommand: CommandModuleWithContext<{ name: string }> = {
  command: 'addresses',
  describe: 'Display the addresses of core Hyperlane contracts',
  builder: {
    name: {
      type: 'string',
      description: 'Chain to display addresses for',
      alias: 'chain',
    },
  },
  handler: async ({ name, context }) => {
    if (name) {
      const result = await context.registry.getChainAddresses(name);
      logBlue('Hyperlane contract addresses for:', name);
      logGray('---------------------------------');
      log(JSON.stringify(result, null, 2));
    } else {
      const result = await context.registry.getAddresses();
      logBlue('Hyperlane contract addresses:');
      logGray('----------------------------------');
      log(JSON.stringify(result, null, 2));
    }
  },
};

/**
 * agent-config command
 */
const createAgentConfigCommand: CommandModuleWithContext<{
  chains?: string;
  environment?: string;
  out: string;
}> = {
  command: 'agent-config',
  describe: 'Create a new agent config',
  builder: (yargs) => {
    yargs
      .option('chains', chainTargetsCommandOption)
      .option('environment', environmentCommandOption)
      .option(
        'out',
        outputFileCommandOption(
          './configs/agent-config.json',
          false,
          'The path to output an agent config JSON file.',
        ),
      )
      .check((argv) => {
        if (!argv.chains && !argv.environment) {
          throw new Error(
            'Either --chains or --environment must be specified.',
          );
        }
        return true;
      })
      .check((argv) => {
        if (argv.chains && argv.environment) {
          throw new Error(
            '--chains and --environment cannot be specified together.',
          );
        }
        return true;
      });

    return yargs as Argv<{
      chains?: string;
      environment?: string;
      out: string;
      context: CommandContext;
    }>;
  },
  handler: async ({
    context,
    chains,
    environment,
    out,
  }: {
    context: CommandContext;
    chains?: string;
    environment?: string;
    out: string;
  }) => {
    const { multiProvider } = context;

    let chainNames;
    if (chains) {
      chainNames = chains.split(',');
      const invalidChainNames = chainNames.filter(
        (chainName) => !multiProvider.hasChain(chainName),
      );
      if (invalidChainNames.length > 0) {
        logRed(
          `Invalid chain names: ${invalidChainNames
            .join(', ')
            .replace(/, $/, '')}`,
        );
        process.exit(1);
      }
    }

    await createAgentConfig({ context, chains: chainNames, environment, out });
    process.exit(0);
  },
};
