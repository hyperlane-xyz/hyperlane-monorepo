import { CommandModule } from 'yargs';

import {
  type CommandModuleWithContext,
} from '../context/types.js';
import { log, logBlue, logCommandHeader, logGreen } from '../logger.js';
import { parseSafeTransaction, parseSquadsTransaction } from '../parse/transactions.js';
import { writeYamlOrJson } from '../utils/files.js';

import { chainCommandOption, outputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const parseCommand: CommandModule = {
  command: 'parse',
  describe: 'Parse and decode multisig transactions (Safe, Squads)',
  builder: (yargs) =>
    yargs
      .command(parseSafe)
      .command(parseSquads)
      .version(false)
      .demandCommand(),

  handler: () => log('Command required'),
};

interface ParseSafeArgs {
  chain: string;
  safeAddress: string;
  txHash?: string;
  output?: string;
}

const parseSafe: CommandModuleWithContext<ParseSafeArgs> = {
  command: 'safe',
  describe: 'Parse a pending Safe transaction',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
      description: 'Chain where the Safe is deployed',
    },
    safeAddress: {
      type: 'string',
      description: 'Address of the Safe multisig',
      demandOption: true,
    },
    txHash: {
      type: 'string',
      description: 'Transaction hash to parse (optional, parses all pending if not specified)',
    },
    output: outputFileCommandOption(),
  },
  handler: async ({ context, chain, safeAddress, txHash, output }) => {
    logCommandHeader('Parse Safe Transaction');

    const result = await parseSafeTransaction(context, chain, safeAddress, txHash);

    if (output) {
      await writeYamlOrJson(output, result);
      logGreen(`Parsed transaction(s) written to ${output}`);
    } else {
      logBlue('Parsed Transaction(s):');
      console.log(JSON.stringify(result, null, 2));
    }

    process.exit(0);
  },
};

interface ParseSquadsArgs {
  chain: string;
  multisig?: string;
  transactionIndex?: number;
  output?: string;
}

const parseSquads: CommandModuleWithContext<ParseSquadsArgs> = {
  command: 'squads',
  describe: 'Parse a pending Squads proposal',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
      description: 'Chain where the Squads multisig is deployed',
    },
    multisig: {
      type: 'string',
      description: 'Address of the Squads multisig (optional, uses default from chain metadata)',
    },
    transactionIndex: {
      type: 'number',
      alias: 't',
      description: 'Transaction index to parse (optional, parses recent pending if not specified)',
    },
    output: outputFileCommandOption(),
  },
  handler: async ({ context, chain, multisig, transactionIndex, output }) => {
    logCommandHeader('Parse Squads Proposal');

    const result = await parseSquadsTransaction(context, chain, multisig, transactionIndex);

    if (output) {
      await writeYamlOrJson(output, result);
      logGreen(`Parsed proposal(s) written to ${output}`);
    } else {
      logBlue('Parsed Proposal(s):');
      console.log(JSON.stringify(result, null, 2));
    }

    process.exit(0);
  },
};
