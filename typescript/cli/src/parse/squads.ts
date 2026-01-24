import yaml from 'yaml';

import { chainCommandOption } from '../commands/options.js';
import { type CommandModuleWithContext } from '../context/types.js';
import { log, logCommandHeader } from '../logger.js';

export const squads: CommandModuleWithContext<{
  chain: string;
  index: number;
  format: 'yaml' | 'json';
}> = {
  command: 'squads',
  describe: 'Parse a Squads proposal',
  builder: {
    chain: {
      ...chainCommandOption,
      description: 'The chain where the Squads proposal is',
      demandOption: true,
    },
    index: {
      type: 'number',
      description: 'The proposal index to parse',
      demandOption: true,
    },
    format: {
      type: 'string',
      description: 'Output format (yaml or json)',
      choices: ['yaml', 'json'],
      default: 'yaml',
    },
  },
  handler: async ({ context: _context, chain, index, format }) => {
    logCommandHeader('Parse Squads Proposal');

    try {
      const proposalData = {
        index,
        chain,
        message: 'Squads proposal parsing requires on-chain data fetch',
      };

      const output =
        format === 'json'
          ? JSON.stringify(proposalData, null, 2)
          : yaml.stringify(proposalData);

      log(output);
    } catch (error: any) {
      throw new Error(`Failed to parse Squads proposal: ${error.message}`);
    }

    process.exit(0);
  },
};
