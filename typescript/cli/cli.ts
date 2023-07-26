#! /usr/bin/env node
import chalk from 'chalk';
import yargs from 'yargs';

import { chainsCommand } from './src/commands/chains.js';
import './src/logger.js';

console.log('⏩', chalk.blue('Hyperlane'), chalk.magentaBright('CLI'), '⏩');
console.log(chalk.gray('==================='));

try {
  await yargs(process.argv.slice(2))
    .scriptName('hyperlane')
    .command(chainsCommand)
    .demandCommand()
    .strict()
    .help().argv;
} catch (error: any) {
  console.error(chalk.red('Error:' + error.message));
}
