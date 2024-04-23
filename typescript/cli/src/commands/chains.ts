import { CommandModule } from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { log, logBlue, logGray, logTable } from '../logger.js';

const ChainTypes = ['mainnet', 'testnet'];
type ChainType = (typeof ChainTypes)[number];

/**
 * Parent command
 */
export const chainsCommand: CommandModule = {
  command: 'chains',
  describe: 'View information about Hyperlane chains in a registry',
  builder: (yargs) =>
    yargs
      .command(listCommand)
      .command(addressesCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * List command
 */
const listCommand: CommandModule = {
  command: 'list',
  describe: 'List all chains included in a registry',
  builder: (yargs) =>
    yargs.option('type', {
      describe: 'Specify the type of chains',
      choices: ChainTypes,
    }),
  handler: async (args) => {
    const type = args.type as ChainType | undefined;
    const context = args.context as CommandContext;

    const logChainsForType = (type: ChainType) => {
      logBlue(`\nHyperlane ${type} chains:`);
      logGray('------------------------------');
      const chains = Object.values(context.chainMetadata).filter(
        (c) => c.isTestnet === (type === 'testnet'),
      );
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
const addressesCommand: CommandModule = {
  command: 'addresses',
  describe: 'Display the addresses of core Hyperlane contracts',
  builder: (yargs) =>
    yargs.options({
      name: {
        type: 'string',
        description: 'Chain to display addresses for',
        alias: 'chain',
      },
    }),
  handler: async (args) => {
    const name = args.name as ChainName | undefined;
    const context = args.context as CommandContext;
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
