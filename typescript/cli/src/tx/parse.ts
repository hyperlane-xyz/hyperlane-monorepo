import { BigNumber } from 'ethers';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
  type CoreProgramIds,
  type SquadsChainConfigInput,
  SquadsTransactionReader,
  type SvmMultisigConfigMap,
  getSafeService,
  parseSafeTx,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';
import { logGray, logGreen, logRed } from '../logger.js';
import {
  logYamlIfUnderMaxLines,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

type ParseSafeTxParams = {
  context: CommandContext;
  chain: ChainName;
  safeTxHash: string;
  output?: string;
};

type ParseSquadsTxParams = {
  context: CommandContext;
  chain: ChainName;
  proposalIndex: number;
  multisigPda: string;
  programId: string;
  coreProgramIdsPath?: string;
  expectedMultisigConfigPath?: string;
  output?: string;
};

function formatParsedValue(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(formatParsedValue);
  return value;
}

function formatSafeDecoded(tx: ReturnType<typeof parseSafeTx>) {
  const argsList = tx.args ? Array.from(tx.args).map(formatParsedValue) : [];
  const args: Record<string, unknown> = {};

  tx.functionFragment.inputs.forEach((input, idx) => {
    const key = input.name?.length ? input.name : `arg${idx}`;
    args[key] = argsList[idx];
  });

  return {
    name: tx.name,
    signature: tx.signature,
    selector: tx.sighash,
    args,
    argsList,
  };
}

function outputParsedResult(result: unknown, output?: string) {
  if (output) {
    writeYamlOrJson(output, result);
    logGreen(`Wrote parse output to ${output}`);
    return;
  }

  logYamlIfUnderMaxLines(result);
}

export async function parseSafeTransaction({
  context,
  chain,
  safeTxHash,
  output,
}: ParseSafeTxParams): Promise<void> {
  logGray(`Parsing Safe tx ${safeTxHash} on ${chain}`);
  const safeService = getSafeService(chain, context.multiProvider);

  let safeTx;
  try {
    safeTx = await safeService.getTransaction(safeTxHash);
  } catch (error) {
    logRed(`Failed to fetch Safe tx ${safeTxHash}: ${error}`);
    throw error;
  }

  const tx: AnnotatedEV5Transaction = {
    to: safeTx.to,
    data: safeTx.data,
    value: BigNumber.from(safeTx.value ?? 0),
  };

  const decoded = parseSafeTx(tx);
  const formatted = formatSafeDecoded(decoded);
  const result = {
    chain,
    safeTxHash,
    to: safeTx.to,
    value: BigNumber.from(safeTx.value ?? 0).toString(),
    decoded: formatted,
  };

  outputParsedResult(result, output);
}

export async function parseSquadsTransaction({
  context,
  chain,
  proposalIndex,
  multisigPda,
  programId,
  coreProgramIdsPath,
  expectedMultisigConfigPath,
  output,
}: ParseSquadsTxParams): Promise<void> {
  logGray(`Parsing Squads proposal ${proposalIndex} on ${chain}`);

  const chainConfig: SquadsChainConfigInput = {
    multisigPda,
    programId,
  };

  if (coreProgramIdsPath) {
    chainConfig.coreProgramIds = readYamlOrJson(
      coreProgramIdsPath,
    ) as CoreProgramIds;
  }

  if (expectedMultisigConfigPath) {
    chainConfig.expectedMultisigIsm = readYamlOrJson(
      expectedMultisigConfigPath,
    ) as SvmMultisigConfigMap;
  }

  const warpRoutes = await context.registry.getWarpRoutes();

  const reader = new SquadsTransactionReader(context.multiProtocolProvider, {
    chainConfigs: {
      [chain]: chainConfig,
    },
  });

  await reader.init(warpRoutes);

  let parsed;
  try {
    parsed = await reader.read(chain, proposalIndex);
  } catch (error) {
    rootLogger.error(`Failed to parse Squads proposal: ${error}`);
    throw error;
  }

  const result = {
    chain,
    proposalIndex,
    parsed,
    errors: reader.errors.length ? reader.errors : undefined,
  };

  outputParsedResult(result, output);
}
