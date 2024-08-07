import { HyperlaneCore, HyperlaneRelayer } from '@hyperlane-xyz/sdk';

import { CommandModuleWithContext } from '../context/types.js';

import { agentTargetsCommandOption } from './options.js';
import { MessageOptionsArgTypes } from './send.js';

export const relayerCommand: CommandModuleWithContext<
  MessageOptionsArgTypes & { chains?: string }
> = {
  command: 'relayer',
  describe: 'Run a CLI relayer',
  builder: {
    chains: {
      ...agentTargetsCommandOption,
      demandOption: false,
    },
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
    relayer.start(chainsArray);
    process.once('SIGINT', async () => {
      relayer.stop(chainsArray);
      console.log('Stopping relayer ...');
      process.exit(0);
    });
  },
};
