import { CommandModule, Options } from 'yargs';

import { ChainName } from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { checkValidatorAvsSetup } from '../avs/check.js';
import {
  deregisterOperator,
  registerOperatorWithSignature,
} from '../avs/stakeRegistry.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { errorRed, log } from '../logger.js';

import {
  avsChainCommandOption,
  demandOption,
  operatorKeyPathCommandOption,
} from './options.js';

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
      .command(checkCommand)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Registration command
 */
export const registrationOptions: { [k: string]: Options } = {
  chain: avsChainCommandOption,
  operatorKeyPath: demandOption(operatorKeyPathCommandOption),
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

const checkCommand: CommandModuleWithWriteContext<{
  chain: ChainName;
  operatorKeyPath?: string;
  operatorAddress?: string;
}> = {
  command: 'check',
  describe: 'Check AVS',
  builder: {
    chain: avsChainCommandOption,
    operatorKeyPath: operatorKeyPathCommandOption,
    operatorAddress: {
      type: 'string',
      description: 'Address of the operator to check',
    },
  },
  handler: async ({ context, chain, operatorKeyPath, operatorAddress }) => {
    const { multiProvider } = context;

    // validate chain
    if (!multiProvider.hasChain(chain)) {
      errorRed(
        `❌ No metadata found for ${chain}. Ensure it is included in your configured registry.`,
      );
      process.exit(1);
    }

    const chainMetadata = multiProvider.getChainMetadata(chain);

    if (chainMetadata.protocol !== ProtocolType.Ethereum) {
      errorRed(`\n❌ Validator AVS check only supports EVM chains. Exiting.`);
      process.exit(1);
    }

    await checkValidatorAvsSetup(
      chain,
      context,
      operatorKeyPath,
      operatorAddress,
    );

    process.exit(0);
  },
};
