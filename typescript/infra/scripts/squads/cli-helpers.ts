import chalk from 'chalk';
import { Argv } from 'yargs';

import {
  ChainName,
  MultiProtocolProvider,
  SquadProposalStatus,
  getSquadsChains,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { logTable } from '../../src/utils/log.js';

export const SQUADS_ENVIRONMENT = 'mainnet3';

export function withTransactionIndex<T>(args: Argv<T>) {
  return args
    .describe('transactionIndex', 'Transaction index of the proposal')
    .number('transactionIndex')
    .demandOption('transactionIndex')
    .alias('t', 'transactionIndex');
}

export function withSquadsChain<T>(args: Argv<T>) {
  return args
    .describe('chain', 'chain name')
    .choices('chain', getSquadsChains())
    .alias('c', 'chain');
}

export function withSquadsChains<T>(args: Argv<T>) {
  return args
    .describe('chains', 'Set of chains to perform actions on.')
    .array('chains')
    .choices('chains', getSquadsChains())
    .coerce(
      'chains',
      (selectedChains: string[] = []) =>
        Array.from(new Set(selectedChains)) as ChainName[],
    )
    .alias('c', 'chains');
}

export function resolveSquadsChains(chains?: ChainName[]): ChainName[] {
  if (chains && chains.length > 0) {
    return chains;
  }
  return getSquadsChains();
}

export async function getSquadsMultiProtocolProvider(): Promise<MultiProtocolProvider> {
  const { getEnvironmentConfig } = await import('../core-utils.js');
  const envConfig = getEnvironmentConfig(SQUADS_ENVIRONMENT);
  return envConfig.getMultiProtocolProvider();
}

export async function getSquadsTurnkeySigner() {
  const { getTurnkeySealevelDeployerSigner } =
    await import('../../src/utils/turnkey.js');
  return getTurnkeySealevelDeployerSigner(SQUADS_ENVIRONMENT);
}

export function logProposals(pendingProposals: SquadProposalStatus[]) {
  rootLogger.info(
    chalk.cyan.bold(`Found ${pendingProposals.length} pending proposal(s):`),
  );

  const formattedProposals = pendingProposals.map((proposal) => ({
    ...proposal,
    approvals: `${proposal.approvals}/${proposal.threshold}`,
  }));

  logTable(formattedProposals, [
    'chain',
    'nonce',
    'submissionDate',
    'fullTxHash',
    'approvals',
    'status',
    'balance',
  ]);
}
