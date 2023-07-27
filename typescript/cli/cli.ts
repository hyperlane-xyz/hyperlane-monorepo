#! /usr/bin/env node
import chalk from 'chalk';
import yargs from 'yargs';

import { chainsCommand } from './src/commands/chains.js';
import { deployCommand } from './src/commands/deploy.js';
import './src/logger.js';

console.log(chalk.blue('Hyperlane'), chalk.magentaBright('CLI'));

try {
  await yargs(process.argv.slice(2))
    .scriptName('hyperlane')
    .command(chainsCommand)
    .command(deployCommand)
    .demandCommand()
    .fail((msg, err) => {
      if (err) throw err; // preserve stack
      console.error(msg);
      process.exit(1);
    })
    .strict()
    .help().argv;
} catch (error: any) {
  console.error(chalk.red('Error: ' + error.message));
}
