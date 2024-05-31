import { CommandModule } from 'yargs';

import { log } from '../logger.js';

import { deployCoreCommand } from './deploy.js';

export const CORE_COMMAND = 'core';

export const coreCommand: CommandModule = {
  command: CORE_COMMAND,
  describe: 'Core command',
  builder: (yargs) =>
    yargs.command(deployCoreCommand).version(false).demandCommand(),
  handler: () => log('Command required'),
};
