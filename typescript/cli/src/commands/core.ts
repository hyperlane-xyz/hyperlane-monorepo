import { CommandModule } from 'yargs';

import { log } from '../logger.js';

import { deploy } from './deploy.js';

export const CORE_COMMAND = 'core';

export const coreCommand: CommandModule = {
  command: CORE_COMMAND,
  describe: 'Core command',
  builder: (yargs) =>
    yargs
      .command(deploy(CORE_COMMAND))
      // .command(read(CORE_COMMAND))
      // .command(update(CORE_COMMAND))
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};
