import chalk from 'chalk';
import { CommandModule } from 'yargs';

import { Mainnets, Testnets, chainMetadata } from '@hyperlane-xyz/sdk';

/**
 * Parent command
 */
export const chainsCommand: CommandModule = {
  command: 'chains',
  describe: 'View information about core Hyperlane chains',
  builder: (yargs) => yargs.command(listCommand).demandCommand(),
  handler: () => console.log('Command required'),
};

/**
 * List command
 */
const listCommand: CommandModule = {
  command: 'list',
  describe: 'List all core chains included in the Hyperlane SDK',
  handler: () => {
    console.log(chalk.blue('Hyperlane core mainnet chains:'));
    console.log(chalk.gray('------------------------------'));
    console.log(
      Mainnets.map((chain) => chainMetadata[chain].displayName).join(', '),
    );
    console.log('');
    console.log(chalk.blue('Hyperlane core testnet chains:'));
    console.log(chalk.gray('------------------------------'));
    console.log(
      Testnets.map((chain) => chainMetadata[chain].displayName).join(', '),
    );
  },
};
