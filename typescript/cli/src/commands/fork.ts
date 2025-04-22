import { CommandModuleWithContext } from '../context/types.js';
import {
  RawForkedChainConfigByChain,
  RawForkedChainConfigByChainSchema,
  runForkCommand,
} from '../fork/fork.js';
import { readYamlOrJson } from '../utils/files.js';

export const forkCommand: CommandModuleWithContext<{
  port?: number;
  symbol?: string;
  'fork-config'?: string;
  kill: boolean;
}> = {
  command: 'fork',
  describe: 'Fork a Hyperlane chain on a compatible Anvil/Hardhat node',
  builder: {
    port: {
      type: 'number',
      description:
        'Port to be used as initial port from which assign port numbers to all anvil instances',
      default: 8545,
    },
    'fork-config': {
      type: 'string',
      description:
        'The path to a configuration file that specifies how to build the forked chains',
    },
    kill: {
      type: 'boolean',
      default: false,
      description:
        'If set, it will stop the forked chains once the forked config has been applied',
    },
  },
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
