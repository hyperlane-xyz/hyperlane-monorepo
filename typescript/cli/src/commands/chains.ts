import { CommandModule } from 'yargs';

import {
  Chains,
  CoreChainName,
  HyperlaneEnvironment,
  chainMetadata,
  hyperlaneContractAddresses,
  hyperlaneEnvironments,
} from '@hyperlane-xyz/sdk';

import { log, logBlue, logGray, logTable } from '../logger.js';

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
  builder: (yargs) =>
    yargs.option('environment', {
      alias: 'e',
      describe: 'Specify the environment to list chains for',
      choices: ['mainnet', 'testnet'],
    }),
  handler: (args) => {
    const environment = args.environment as HyperlaneEnvironment | undefined;

    const serializer = (env: HyperlaneEnvironment) =>
      Object.keys(hyperlaneEnvironments[env]).reduce<any>((result, chain) => {
        const { chainId, displayName } = chainMetadata[chain];
        result[chain] = {
          'Display Name': displayName,
          'Chain Id': chainId,
        };
        return result;
      }, {});

    const logChainsForEnv = (env: HyperlaneEnvironment) => {
      logBlue(`\nHyperlane core ${env} chains:`);
      logGray('------------------------------');
      logTable(serializer(env));
    };

    if (environment) {
      logChainsForEnv(environment);
    } else {
      logChainsForEnv('mainnet');
      logChainsForEnv('testnet');
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
