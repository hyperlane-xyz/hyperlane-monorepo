import { CommandModule, Options } from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import {
  deregisterOperator,
  registerOperatorWithSignature,
} from '../avs/stakeRegistry.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { log } from '../logger.js';

/**
 * Parent command
 */
export const avsCommand: CommandModule = {
  command: 'avs',
  describe: 'Interact with the Hyperlane AVS',
  builder: (yargs) =>
    yargs
      .command(registerCommand)
      .command(deregisterCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Registration command
 */
export const registrationOptions: { [k: string]: Options } = {
  chain: {
    type: 'string',
    description: 'Chain to interact with the AVS on',
    demandOption: true,
    choices: ['holesky', 'ethereum'],
  },
  operatorKeyPath: {
    type: 'string',
    description: 'Path to the operator key file',
    demandOption: true,
  },
  avsSigningKeyAddress: {
    type: 'string',
    description: 'Address of the AVS signing key',
    demandOption: true,
  },
};

const registerCommand: CommandModuleWithWriteContext<{
  chain: ChainName;
  operatorKeyPath: string;
  avsSigningKeyAddress: Address;
}> = {
  command: 'register',
  describe: 'Register operator with the AVS',
  builder: registrationOptions,
  handler: async ({
    context,
    chain,
    operatorKeyPath,
    avsSigningKeyAddress,
  }) => {
    await registerOperatorWithSignature({
      context,
      chain,
      operatorKeyPath,
      avsSigningKeyAddress,
    });
    process.exit(0);
  },
};

const deregisterCommand: CommandModuleWithWriteContext<{
  chain: ChainName;
  operatorKeyPath: string;
}> = {
  command: 'deregister',
  describe: 'Deregister yourself with the AVS',
  builder: registrationOptions,
  handler: async ({ context, chain, operatorKeyPath }) => {
    await deregisterOperator({
      context,
      chain,
      operatorKeyPath,
    });
    process.exit(0);
  },
};
