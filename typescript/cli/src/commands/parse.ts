import { type CommandModule } from 'yargs';

import { log } from '../logger.js';
import { safe } from '../parse/safe.js';
import { squads } from '../parse/squads.js';

/**
 * Parent command for parsing multisig transactions
 */
export const parseCommand: CommandModule = {
  command: 'parse',
  describe: 'Parse multisig transactions (Safe, Squads)',
  builder: (yargs) =>
    yargs.command(safe).command(squads).version(false).demandCommand(),
  handler: () => log('Subcommand required'),
};
