import { type CommandModule } from 'yargs';

import { type ChainName } from '@hyperlane-xyz/sdk';

import { type CommandModuleWithContext } from '../context/types.js';
import { log } from '../logger.js';
import { parseSafeTransaction, parseSquadsTransaction } from '../tx/parse.js';

import { chainCommandOption, outputFileCommandOption } from './options.js';

export const txCommand: CommandModule = {
  command: 'tx',
  describe: 'Parse transactions',
  builder: (yargs) =>
    yargs
      .command(parseSafe)
      .command(parseSquads)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const parseSafe: CommandModuleWithContext<{
  chain: string;
  tx: string;
  output?: string;
}> = {
  command: 'parse-safe',
  describe: 'Parse a Safe transaction by hash',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    tx: {
      type: 'string',
      description: 'Safe transaction hash',
      demandOption: true,
    },
    output: outputFileCommandOption(
      undefined,
      false,
      'Output file path for parsed Safe transaction',
    ),
  },
  handler: async ({ context, chain, tx, output }) => {
    await parseSafeTransaction({
      context,
      chain: chain as ChainName,
      safeTxHash: tx,
      output,
    });
    process.exit(0);
  },
};

export const parseSquads: CommandModuleWithContext<{
  chain: string;
  proposal: string;
  multisig: string;
  programId: string;
  coreProgramIds?: string;
  expectedMultisigConfig?: string;
  output?: string;
}> = {
  command: 'parse-squads',
  describe: 'Parse a Squads proposal by index',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    proposal: {
      type: 'string',
      description: 'Squads proposal transaction index',
      demandOption: true,
    },
    multisig: {
      type: 'string',
      description: 'Squads multisig PDA (base58)',
      demandOption: true,
    },
    programId: {
      type: 'string',
      description: 'Squads program ID (base58)',
      demandOption: true,
    },
    coreProgramIds: {
      type: 'string',
      description:
        'Path to core program IDs JSON (program-ids.json) for the chain',
    },
    expectedMultisigConfig: {
      type: 'string',
      description:
        'Path to expected multisig config JSON for verification (optional)',
    },
    output: outputFileCommandOption(
      undefined,
      false,
      'Output file path for parsed Squads proposal',
    ),
  },
  handler: async ({
    context,
    chain,
    proposal,
    multisig,
    programId,
    coreProgramIds,
    expectedMultisigConfig,
    output,
  }) => {
    const proposalIndex = Number(proposal);
    if (!Number.isInteger(proposalIndex) || proposalIndex < 0) {
      throw new Error(`Invalid proposal index: ${proposal}`);
    }

    await parseSquadsTransaction({
      context,
      chain: chain as ChainName,
      proposalIndex,
      multisigPda: multisig,
      programId,
      coreProgramIdsPath: coreProgramIds,
      expectedMultisigConfigPath: expectedMultisigConfig,
      output,
    });
    process.exit(0);
  },
};
