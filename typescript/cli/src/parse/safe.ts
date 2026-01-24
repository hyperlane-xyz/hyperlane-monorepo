import yaml from 'yaml';

import { parseSafeTx } from '@hyperlane-xyz/sdk';

import { chainCommandOption } from '../commands/options.js';
import { type CommandModuleWithContext } from '../context/types.js';
import { log, logCommandHeader } from '../logger.js';

export const safe: CommandModuleWithContext<{
  chain: string;
  txHash: string;
  format: 'yaml' | 'json';
}> = {
  command: 'safe',
  describe: 'Parse a Safe transaction',
  builder: {
    chain: {
      ...chainCommandOption,
      description: 'The chain where the Safe transaction is',
      demandOption: true,
    },
    txHash: {
      type: 'string',
      description: 'The transaction hash to parse',
      alias: 'tx',
      demandOption: true,
    },
    format: {
      type: 'string',
      description: 'Output format (yaml or json)',
      choices: ['yaml', 'json'],
      default: 'yaml',
    },
  },
  handler: async ({ context, chain, txHash, format }) => {
    logCommandHeader('Parse Safe Transaction');

    try {
      const provider = context.multiProvider.getProvider(chain);
      const tx = await provider.getTransaction(txHash);

      if (!tx) {
        throw new Error(`Transaction ${txHash} not found on ${chain}`);
      }

      const parsed = parseSafeTx(tx as any);
      const output =
        format === 'json'
          ? JSON.stringify(parsed, null, 2)
          : yaml.stringify(parsed);

      log(output);
    } catch (error: any) {
      throw new Error(`Failed to parse Safe transaction: ${error.message}`);
    }

    process.exit(0);
  },
};
