import { CommandModule } from 'yargs';

import {
  Chains,
  CoreChainName,
  Mainnets,
  Testnets,
  chainMetadata,
  hyperlaneContractAddresses,
} from '@hyperlane-xyz/sdk';

import { log, logBlue, logGray, logTable } from '../../logger.js';

/**
 * Parent command
 */
export const chainsCommand: CommandModule = {
  command: 'chains',
  describe: 'View information about core Hyperlane chains',
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
  describe: 'List all core chains included in the Hyperlane SDK',
  handler: () => {
    const serializer = (chains: string[]) =>
      chains.reduce<any>((result, chain) => {
        result[chain] = {
          'Display Name': chainMetadata[chain].displayName,
          'Chain Id': chainMetadata[chain].chainId,
        };
        return result;
      }, {});

    logBlue('Hyperlane core mainnet chains:');
    logGray('------------------------------');
    logTable(serializer(Mainnets));
    logBlue('\nHyperlane core testnet chains:');
    logGray('------------------------------');
    logTable(serializer(Testnets));
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
        choices: Object.values(Chains),
        alias: 'chain',
      },
    }),
  handler: (args) => {
    const name = args.name as CoreChainName | undefined;
    if (name && hyperlaneContractAddresses[name]) {
      logBlue('Hyperlane contract addresses for:', name);
      logGray('---------------------------------');
      log(JSON.stringify(hyperlaneContractAddresses[name], null, 2));
    } else {
      logBlue('Hyperlane core contract addresses:');
      logGray('----------------------------------');
      log(JSON.stringify(hyperlaneContractAddresses, null, 2));
    }
  },
};
