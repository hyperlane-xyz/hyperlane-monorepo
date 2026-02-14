import chalk from 'chalk';
import { Argv } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainName,
  MultiProtocolProvider,
  SquadProposalStatus,
  getSquadsChains,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import type {
  DeployEnvironment,
  EnvironmentConfig,
} from '../../src/config/environment.js';
import { logTable } from '../../src/utils/log.js';

export const SQUADS_ENVIRONMENT = 'mainnet3';
const environmentConfigPromises: Partial<
  Record<DeployEnvironment, Promise<EnvironmentConfig>>
> = {};
const multiProtocolProviderPromises: Partial<
  Record<DeployEnvironment, Promise<MultiProtocolProvider>>
> = {};
const turnkeySignerPromises: Partial<
  Record<
    DeployEnvironment,
    Promise<
      Awaited<
        ReturnType<
          (typeof import('../../src/utils/turnkey.js'))['getTurnkeySealevelDeployerSigner']
        >
      >
    >
  >
> = {};
const registryPromises: Partial<Record<DeployEnvironment, Promise<IRegistry>>> =
  {};

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

export async function getEnvironmentConfigFor(
  environment: DeployEnvironment,
): Promise<EnvironmentConfig> {
  environmentConfigPromises[environment] ??= import('../core-utils.js').then(
    ({ getEnvironmentConfig }) => getEnvironmentConfig(environment),
  );
  return environmentConfigPromises[environment]!;
}

export async function getSquadsEnvironmentConfig(): Promise<EnvironmentConfig> {
  return getEnvironmentConfigFor(SQUADS_ENVIRONMENT);
}

export async function getMultiProtocolProviderFor(
  environment: DeployEnvironment,
): Promise<MultiProtocolProvider> {
  multiProtocolProviderPromises[environment] ??= getEnvironmentConfigFor(
    environment,
  ).then((envConfig) => envConfig.getMultiProtocolProvider());
  return multiProtocolProviderPromises[environment]!;
}

export async function getSquadsMultiProtocolProvider(): Promise<MultiProtocolProvider> {
  return getMultiProtocolProviderFor(SQUADS_ENVIRONMENT);
}

export async function getTurnkeySignerFor(
  environment: DeployEnvironment,
): Promise<
  Awaited<
    ReturnType<
      (typeof import('../../src/utils/turnkey.js'))['getTurnkeySealevelDeployerSigner']
    >
  >
> {
  turnkeySignerPromises[environment] ??=
    import('../../src/utils/turnkey.js').then(
      ({ getTurnkeySealevelDeployerSigner }) =>
        getTurnkeySealevelDeployerSigner(environment),
    );
  return turnkeySignerPromises[environment]!;
}

export async function getSquadsTurnkeySigner(): Promise<
  Awaited<
    ReturnType<
      (typeof import('../../src/utils/turnkey.js'))['getTurnkeySealevelDeployerSigner']
    >
  >
> {
  return getTurnkeySignerFor(SQUADS_ENVIRONMENT);
}

export async function getRegistryFor(
  environment: DeployEnvironment,
): Promise<IRegistry> {
  registryPromises[environment] ??= getEnvironmentConfigFor(environment).then(
    (envConfig) => envConfig.getRegistry(),
  );
  return registryPromises[environment]!;
}

export async function getSquadsRegistry(): Promise<IRegistry> {
  return getRegistryFor(SQUADS_ENVIRONMENT);
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
