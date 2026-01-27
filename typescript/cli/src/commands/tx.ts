import { BigNumber } from 'ethers';
import { type CommandModule } from 'yargs';

import {
  SquadsTransactionReader,
  getSafeService,
  parseSafeTx,
  type MultiProvider,
  type SquadsConfig,
  type SquadsTransaction,
  type SvmCoreProgramIds,
  type SvmMultisigConfigMap,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { type CommandModuleWithContext } from '../context/types.js';
import { log, logCommandHeader, logGreen, logRed } from '../logger.js';
import { logYamlIfUnderMaxLines, readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { chainCommandOption, inputFileCommandOption, outputFileCommandOption } from './options.js';

/**
 * Parent command
 */
export const txCommand: CommandModule = {
  command: 'tx',
  describe: 'Parse transactions',
  builder: (yargs) =>
    yargs.command(parseSafe).command(parseSquads).version(false).demandCommand(),
  handler: () => log('Command required'),
};

const parseSafe: CommandModuleWithContext<{
  chain: string;
  safeTxHash?: string;
  txFile?: string;
  out?: string;
}> = {
  command: 'safe',
  describe: 'Parse a Safe transaction',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    safeTxHash: {
      type: 'string',
      description: 'Safe transaction hash to fetch from the Safe service',
    },
    txFile: inputFileCommandOption({
      demandOption: false,
      description: 'Path to a JSON or YAML file with { to, data, value }',
      alias: 'tx-file',
    }),
    out: outputFileCommandOption(undefined, false, 'Output file path'),
  },
  handler: async ({ context, chain, safeTxHash, txFile, out }) => {
    logCommandHeader('Hyperlane TX Safe Parse');

    if (!safeTxHash && !txFile) {
      throw new Error('Provide either --safeTxHash or --tx-file');
    }
    if (safeTxHash && txFile) {
      throw new Error('Provide only one of --safeTxHash or --tx-file');
    }

    const tx =
      safeTxHash !== undefined
        ? await readSafeTxFromService(chain, context.multiProvider, safeTxHash)
        : readSafeTxFromFile(txFile!);

    const decoded = parseSafeTx(tx);
    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );

    const output = {
      chain,
      safeTxHash,
      to: tx.to,
      value: tx.value?.toString(),
      signature: decoded.signature,
      name: decoded.name,
      args,
    };

    if (out) {
      writeYamlOrJson(out, output, 'yaml');
      logGreen(`Parsed transaction written to ${out}`);
    } else {
      logGreen('Parsed transaction:');
      logYamlIfUnderMaxLines(output);
    }
  },
};

const parseSquads: CommandModuleWithContext<{
  chain: string;
  transactionIndex: number;
  programId: string;
  multisigPda: string;
  vault?: string;
  coreProgramIds?: string;
  mailboxProgramId?: string;
  multisigIsmProgramId?: string;
  expectedMultisigConfig?: string;
  out?: string;
}> = {
  command: 'squads',
  describe: 'Parse a Squads proposal transaction',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    transactionIndex: {
      type: 'number',
      description: 'Transaction index of the proposal',
      demandOption: true,
      alias: ['t', 'transaction-index'],
    },
    programId: {
      type: 'string',
      description: 'Squads program ID',
      demandOption: true,
      alias: ['squads-program-id'],
    },
    multisigPda: {
      type: 'string',
      description: 'Squads multisig PDA',
      demandOption: true,
      alias: ['squads-multisig-pda'],
    },
    vault: {
      type: 'string',
      description: 'Optional Squads vault PDA',
      demandOption: false,
    },
    coreProgramIds: inputFileCommandOption({
      demandOption: false,
      description:
        'Path to a JSON or YAML file with core program IDs (mailbox, multisigIsmMessageId)',
      alias: ['core-program-ids'],
    }),
    mailboxProgramId: {
      type: 'string',
      description: 'Mailbox program ID override',
      demandOption: false,
      alias: ['mailbox-program-id'],
    },
    multisigIsmProgramId: {
      type: 'string',
      description: 'Multisig ISM program ID override',
      demandOption: false,
      alias: ['multisig-ism-program-id'],
    },
    expectedMultisigConfig: inputFileCommandOption({
      demandOption: false,
      description:
        'Path to a JSON or YAML file with expected multisig config for this chain',
      alias: ['expected-multisig-config'],
    }),
    out: outputFileCommandOption(undefined, false, 'Output file path'),
  },
  handler: async ({
    context,
    chain,
    transactionIndex,
    programId,
    multisigPda,
    vault,
    coreProgramIds,
    mailboxProgramId,
    multisigIsmProgramId,
    expectedMultisigConfig,
    out,
  }) => {
    logCommandHeader('Hyperlane TX Squads Parse');

    const squadsConfig: SquadsConfig = {
      programId,
      multisigPda,
      ...(vault ? { vault } : {}),
    };

    const resolvedCorePrograms = await resolveCoreProgramIds({
      chain,
      context,
      coreProgramIdsPath: coreProgramIds,
      mailboxProgramId,
      multisigIsmProgramId,
    });

    const expectedConfig = expectedMultisigConfig
      ? (readYamlOrJson(expectedMultisigConfig) as SvmMultisigConfigMap)
      : undefined;

    const reader = new SquadsTransactionReader({
      mpp: context.multiProtocolProvider,
      squadsConfigByChain: { [chain]: squadsConfig },
      coreProgramIdsByChain: resolvedCorePrograms
        ? { [chain]: resolvedCorePrograms }
        : undefined,
      expectedMultisigConfigsByChain: expectedConfig
        ? { [chain]: expectedConfig }
        : undefined,
    });

    const warpRoutes = await context.registry.getWarpRoutes();
    await reader.init(warpRoutes);

    let result: SquadsTransaction;
    try {
      result = await reader.read(chain, transactionIndex);
    } catch (error) {
      logRed(`Failed to parse Squads proposal: ${error}`);
      throw error;
    }

    const output = {
      chain,
      transactionIndex,
      result,
      errors: reader.errors,
    };

    if (out) {
      writeYamlOrJson(out, output, 'yaml');
      logGreen(`Parsed proposal written to ${out}`);
    } else {
      logGreen('Parsed proposal:');
      logYamlIfUnderMaxLines(output);
    }
  },
};

async function readSafeTxFromService(
  chain: string,
  multiProvider: MultiProvider,
  safeTxHash: string,
) {
  const safeService = getSafeService(chain, multiProvider);
  const safeTx = await safeService.getTransaction(safeTxHash);
  if (!safeTx) {
    throw new Error(`Safe transaction not found: ${safeTxHash}`);
  }

  return {
    to: safeTx.to,
    data: safeTx.data ?? '0x',
    value: BigNumber.from(safeTx.value ?? 0),
  };
}

function readSafeTxFromFile(txFile: string) {
  const tx = readYamlOrJson(txFile) as {
    to?: string;
    data?: string;
    value?: string | number;
  };

  if (!tx.to) {
    throw new Error('Transaction file is missing "to"');
  }

  return {
    to: tx.to,
    data: tx.data ?? '0x',
    value: BigNumber.from(tx.value ?? 0),
  };
}

function formatFunctionFragmentArgs(
  args: any,
  fragment: { inputs: Array<{ name: string }> },
): Record<string, any> {
  const accumulator: Record<string, any> = {};
  return fragment.inputs.reduce((acc, input, index) => {
    acc[input.name] = args[index];
    return acc;
  }, accumulator);
}

async function resolveCoreProgramIds(params: {
  chain: string;
  context: {
    registry: { getChainAddresses: (chain: string) => Promise<any> };
    chainMetadata: Record<string, any>;
  };
  coreProgramIdsPath?: string;
  mailboxProgramId?: string;
  multisigIsmProgramId?: string;
}): Promise<SvmCoreProgramIds | undefined> {
  const {
    chain,
    context,
    coreProgramIdsPath,
    mailboxProgramId,
    multisigIsmProgramId,
  } = params;

  const coreProgramIds: SvmCoreProgramIds = coreProgramIdsPath
    ? (readYamlOrJson(coreProgramIdsPath) as SvmCoreProgramIds)
    : {};

  if (mailboxProgramId) {
    coreProgramIds.mailbox = mailboxProgramId;
  }

  if (multisigIsmProgramId) {
    coreProgramIds.multisigIsmMessageId = multisigIsmProgramId;
  }

  if (!coreProgramIds.mailbox || !coreProgramIds.multisigIsmMessageId) {
    try {
      const addresses = (await context.registry.getChainAddresses(chain)) as Record<
        string,
        string
      >;
      coreProgramIds.mailbox ??= addresses.mailbox;
      coreProgramIds.multisigIsmMessageId ??=
        addresses.multisigIsmMessageId ?? addresses.multisig_ism_message_id;
    } catch (error) {
      rootLogger.warn(`Failed to read chain addresses for ${chain}: ${error}`);
    }
  }

  if (!coreProgramIds.multisigIsmMessageId) {
    const metadata = context.chainMetadata[chain] ?? {};
    coreProgramIds.multisigIsmMessageId ??=
      metadata.multisigIsmMessageId ?? metadata.multisig_ism_message_id;
  }

  if (!coreProgramIds.mailbox && !coreProgramIds.multisigIsmMessageId) {
    return undefined;
  }

  return coreProgramIds;
}
