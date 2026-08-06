import { type CommandModuleWithContext } from '../context/types.js';
import {
  type ForkConfigByChain,
  ForkConfigByChainSchema,
  runForkCommand,
} from '../fork/fork.js';
import { readYamlOrJson } from '../utils/files.js';

import { forkCommandOptions } from './options.js';

export const forkCommand: CommandModuleWithContext<{
  port?: number;
  symbol?: string;
  'fork-config'?: string;
  kill: boolean;
}> = {
  command: 'fork',
  describe:
    'Fork Hyperlane chains on a per-protocol local node (Anvil for EVM, surfpool for Sealevel) and replay governance transactions',
  builder: forkCommandOptions,
  handler: async ({ context, port, kill, forkConfig: forkConfigPath }) => {
    let forkConfig: ForkConfigByChain;
    if (forkConfigPath) {
      forkConfig = ForkConfigByChainSchema.parse(
        readYamlOrJson(forkConfigPath),
      );
    } else {
      forkConfig = {};
    }

    await runForkCommand({
      context,
      chainsToFork: new Set(Object.keys(forkConfig)),
      forkConfig,
      basePort: port,
      kill,
    });
  },
};
