import { HyperlaneCore, HyperlaneRelayer } from '@hyperlane-xyz/sdk';

import { CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';

import { agentTargetsCommandOption } from './options.js';
import { MessageOptionsArgTypes } from './send.js';

export const relayerCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & { chains?: string }
> = {
  command: 'relayer',
  describe: 'Run a Hyperlane message self-relayer',
  builder: {
    chains: agentTargetsCommandOption,
  },
  handler: async ({ context, chains }) => {
    const chainsArray = chains
      ? chains.split(',').map((_) => _.trim())
      : undefined;
    const chainAddresses = await context.registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(
      chainAddresses,
      context.multiProvider,
    );

    const relayer = new HyperlaneRelayer({ core });
    log('Starting relayer ...');
    relayer.start(chainsArray);
    process.once('SIGINT', () => {
      relayer.stop(chainsArray);
      log('Stopping relayer ...');
      process.exit(0);
    });
  },
};
