import { CommandModule } from 'yargs';

import {
  Chains,
  CoreChainName,
  Mainnets,
  Testnets,
  chainMetadata,
  hyperlaneContractAddresses,
} from '@hyperlane-xyz/sdk';

import { log, logBlue, logGray } from '../../logger.js';

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
    logBlue('Hyperlane core mainnet chains:');
    logGray('------------------------------');
    log(Mainnets.map((chain) => chainMetadata[chain].displayName).join(', '));
    log('');
    logBlue('Hyperlane core testnet chains:');
    logGray('------------------------------');
    log(Testnets.map((chain) => chainMetadata[chain].displayName).join(', '));
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
