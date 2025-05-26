#! /usr/bin/env node
import chalk from 'chalk';
import yargs from 'yargs';

import type { LogFormat, LogLevel } from '@hyperlane-xyz/utils';

import './env.js';
import { avsCommand } from './src/commands/avs.js';
import { configCommand } from './src/commands/config.js';
import { coreCommand } from './src/commands/core.js';
import { deployCommand } from './src/commands/deploy.js';
import { hookCommand } from './src/commands/hook.js';
import { ismCommand } from './src/commands/ism.js';
import {
  disableProxyCommandOption,
  githubAuthTokenOption,
  keyCommandOption,
  logFormatCommandOption,
  logLevelCommandOption,
  overrideRegistryUriCommandOption,
  registryUrisCommandOption,
  signerCommandOption,
  skipConfirmationOption,
  strategyCommandOption,
} from './src/commands/options.js';
import { registryCommand } from './src/commands/registry.js';
import { relayerCommand } from './src/commands/relayer.js';
import { sendCommand } from './src/commands/send.js';
import { statusCommand } from './src/commands/status.js';
import { strategyCommand } from './src/commands/strategy.js';
import { submitCommand } from './src/commands/submit.js';
import { validatorCommand } from './src/commands/validator.js';
import { warpCommand } from './src/commands/warp.js';
import { contextMiddleware, signerMiddleware } from './src/context/context.js';
import { configureLogger, errorRed } from './src/logger.js';
import { checkVersion } from './src/utils/version-check.js';
import { VERSION } from './src/version.js';

console.log(chalk.blue('Hyperlane'), chalk.magentaBright('CLI'));

await checkVersion();

try {
  await yargs(process.argv.slice(2))
    .scriptName('hyperlane')
    .option('log', logFormatCommandOption)
    .option('verbosity', logLevelCommandOption)
    .option('registry', registryUrisCommandOption)
    .option('authToken', githubAuthTokenOption)
    .option('overrides', overrideRegistryUriCommandOption)
    .option('key', keyCommandOption)
    .option('signer', signerCommandOption)
    .option('disableProxy', disableProxyCommandOption)
    .option('yes', skipConfirmationOption)
    .option('strategy', strategyCommandOption)
    .global(['log', 'verbosity', 'registry', 'overrides', 'yes'])
    .middleware([
      (argv) => {
        configureLogger(argv.log as LogFormat, argv.verbosity as LogLevel);
      },
      contextMiddleware,
      signerMiddleware,
    ])
    .command(avsCommand)
    .command(configCommand)
    .command(coreCommand)
    .command(deployCommand)
    .command(hookCommand)
    .command(ismCommand)
    .command(registryCommand)
    .command(relayerCommand)
    .command(sendCommand)
    .command(statusCommand)
    .command(strategyCommand)
    .command(submitCommand)
    .command(validatorCommand)
    .command(warpCommand)
    .version(VERSION)
    .demandCommand()
    .strict()
    .help()
    .showHelpOnFail(false).argv;
} catch (error: any) {
  errorRed('Error: ' + error.message);
}
