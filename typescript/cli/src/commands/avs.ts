import { CommandModule, Options } from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';

import { registerOperatorWithSignature } from '../avs/stakeRegistry.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { log } from '../logger.js';

/**
 * Parent command
 */
export const avsCommand: CommandModule = {
  command: 'avs',
  describe: 'Interact with the Hyperlane AVS',
  builder: (yargs) =>
    yargs.command(registerCommand).version(false).demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Register command
 */
export const registerOptions: { [k: string]: Options } = {
  chain: {
    type: 'string',
    description: 'Origin chain to send message from',
    demandOption: true,
  },
  operatorKeyPath: {
    type: 'string',
    description: 'Destination chain to send message to',
    demandOption: true,
  },
};

const registerCommand: CommandModuleWithWriteContext<{
  chain: ChainName;
  operatorKeyPath: string;
}> = {
  command: 'register',
  describe: 'Register yourself with the AVS',
  builder: {
    ...registerOptions,
  },
  handler: async ({ context, chain, operatorKeyPath }) => {
    await registerOperatorWithSignature({
      context,
      chain,
      operatorKeyPath,
    });
    process.exit(0);
  },
};
