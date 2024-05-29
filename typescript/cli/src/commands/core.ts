import { CommandModule } from 'yargs';

import { coreDeploy } from '../deploy/core.js';
import { log } from '../logger.js';

import { deployWith } from './deploy.js';

export const coreCommand: CommandModule = {
  command: 'core',
  describe: 'Core command',
  builder: (yargs) => yargs.command(deployWith(coreDeploy)),
  handler: () => log('Command required'),
};
