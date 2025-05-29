import {
  RawForkedChainConfigByChain,
  RawForkedChainConfigByChainSchema,
} from '@hyperlane-xyz/sdk';

import { CommandModuleWithContext } from '../context/types.js';
import { runForkCommand } from '../fork/fork.js';
import { readYamlOrJson } from '../utils/files.js';

import { forkCommandOptions } from './options.js';

export const forkCommand: CommandModuleWithContext<{
  port?: number;
  symbol?: string;
  'fork-config'?: string;
  kill: boolean;
}> = {
  command: 'fork',
  describe: 'Fork a Hyperlane chain on a compatible Anvil/Hardhat node',
  builder: forkCommandOptions,
  handler: async ({ context, port, kill, forkConfig: forkConfigPath }) => {
    let forkConfig: RawForkedChainConfigByChain;
    if (forkConfigPath) {
      forkConfig = RawForkedChainConfigByChainSchema.parse(
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
