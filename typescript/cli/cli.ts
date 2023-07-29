#! /usr/bin/env node
import chalk from 'chalk';
import yargs from 'yargs';

import { chainsCommand } from './src/commands/chains.js';
import { configCommand } from './src/commands/config.js';
import { deployCommand } from './src/commands/deploy.js';
import './src/logger.js';
import { errorRed } from './src/logger.js';

const MISSING_PARAMS_ERROR = 'Not enough non-option arguments';

console.log(chalk.blue('Hyperlane'), chalk.magentaBright('CLI'));

try {
  await yargs(process.argv.slice(2))
    .scriptName('hyperlane')
    // TODO get version num from package.json
    .version(false)
    .command(chainsCommand)
    .command(configCommand)
    .command(deployCommand)
    .demandCommand()
    .strict()
    .help()
    .fail((msg, err, yargs) => {
      if (msg && !msg.includes(MISSING_PARAMS_ERROR)) errorRed('Error: ' + msg);
      console.log('');
      yargs.showHelp();
      console.log('');
      if (err) errorRed(err.toString());
      process.exit(1);
    }).argv;
} catch (error: any) {
  errorRed('Error: ' + error.message);
}
