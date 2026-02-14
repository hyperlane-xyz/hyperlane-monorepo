import chalk from 'chalk';
import { Argv } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  ChainName,
  MultiProtocolProvider,
  SquadProposalStatus,
  getSquadsChains,
  partitionSquadsChains,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import type {
  DeployEnvironment,
  EnvironmentConfig,
} from '../../src/config/environment.js';
import { logTable } from '../../src/utils/log.js';

export const SQUADS_ENVIRONMENT = 'mainnet3';
type TurnkeySealevelDeployerSigner = Awaited<
  ReturnType<
    (typeof import('../../src/utils/turnkey.js'))['getTurnkeySealevelDeployerSigner']
  >
>;
const environmentConfigPromises = new Map<
  DeployEnvironment,
  Promise<EnvironmentConfig>
>();
const multiProtocolProviderPromises = new Map<
  DeployEnvironment,
  Promise<MultiProtocolProvider>
>();
const turnkeySignerPromises = new Map<
  DeployEnvironment,
  Promise<TurnkeySealevelDeployerSigner>
>();
const registryPromises = new Map<DeployEnvironment, Promise<IRegistry>>();

function memoizeByEnvironment<T>(
  cache: Map<DeployEnvironment, Promise<T>>,
  environment: DeployEnvironment,
  factory: () => Promise<T>,
): Promise<T> {
  const cachedPromise = cache.get(environment);
  if (cachedPromise) {
    return cachedPromise;
  }

  const promise = factory().catch((error) => {
    cache.delete(environment);
    throw error;
  });
  cache.set(environment, promise);
  return promise;
}

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

export function withRequiredSquadsChain<T>(args: Argv<T>) {
  return withSquadsChain(args).demandOption('chain');
}

export function withSquadsChains<T>(args: Argv<T>) {
  return args
    .describe('chains', 'Set of chains to perform actions on.')
    .array('chains')
    .choices('chains', getSquadsChains())
    .coerce('chains', (selectedChains: unknown[] = []) =>
      Array.from(new Set(selectedChains.map((chain) => String(chain)))),
    )
    .alias('c', 'chains');
}

export function getUnsupportedSquadsChainsErrorMessage(
  nonSquadsChains: readonly string[],
  configuredSquadsChains: readonly string[] = getSquadsChains(),
): string {
  assert(
    nonSquadsChains.length > 0,
    'Expected at least one unsupported squads chain to format error message',
  );
  const uniqueNonSquadsChains = Array.from(new Set(nonSquadsChains));
  const uniqueConfiguredSquadsChains = Array.from(
    new Set(configuredSquadsChains),
  );
  assert(
    uniqueConfiguredSquadsChains.length > 0,
    'Expected at least one configured squads chain',
  );
  return (
    `Squads configuration not found for chains: ${uniqueNonSquadsChains.join(', ')}. ` +
    `Available Squads chains: ${uniqueConfiguredSquadsChains.join(', ')}`
  );
}

export function resolveSquadsChains(chains?: readonly string[]): ChainName[] {
  const configuredSquadsChains = getSquadsChains();
  if (chains && chains.length > 0) {
    const { squadsChains, nonSquadsChains } = partitionSquadsChains([
      ...chains,
    ]);
    if (nonSquadsChains.length > 0) {
      throw new Error(
        getUnsupportedSquadsChainsErrorMessage(
          nonSquadsChains,
          configuredSquadsChains,
        ),
      );
    }
    return [...squadsChains];
  }
  return configuredSquadsChains;
}

function getArgTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

export function resolveSquadsChainsFromArgv(chains: unknown): ChainName[] {
  if (typeof chains === 'undefined') {
    return resolveSquadsChains(undefined);
  }

  if (!Array.isArray(chains)) {
    throw new Error(
      `Expected --chains to resolve to an array, but received ${getArgTypeName(chains)}`,
    );
  }

  return resolveSquadsChains(chains.map((chain) => String(chain)));
}

export async function getEnvironmentConfigFor(
  environment: DeployEnvironment,
): Promise<EnvironmentConfig> {
  return memoizeByEnvironment(environmentConfigPromises, environment, () =>
    import('../core-utils.js').then(({ getEnvironmentConfig }) =>
      getEnvironmentConfig(environment),
    ),
  );
}

export async function getSquadsEnvironmentConfig(): Promise<EnvironmentConfig> {
  return getEnvironmentConfigFor(SQUADS_ENVIRONMENT);
}

export async function getMultiProtocolProviderFor(
  environment: DeployEnvironment,
): Promise<MultiProtocolProvider> {
  return memoizeByEnvironment(multiProtocolProviderPromises, environment, () =>
    getEnvironmentConfigFor(environment).then((envConfig) =>
      envConfig.getMultiProtocolProvider(),
    ),
  );
}

export async function getSquadsMultiProtocolProvider(): Promise<MultiProtocolProvider> {
  return getMultiProtocolProviderFor(SQUADS_ENVIRONMENT);
}

export async function getTurnkeySignerFor(
  environment: DeployEnvironment,
): Promise<TurnkeySealevelDeployerSigner> {
  return memoizeByEnvironment(turnkeySignerPromises, environment, () =>
    import('../../src/utils/turnkey.js').then(
      ({ getTurnkeySealevelDeployerSigner }) =>
        getTurnkeySealevelDeployerSigner(environment),
    ),
  );
}

export async function getSquadsTurnkeySigner(): Promise<TurnkeySealevelDeployerSigner> {
  return getTurnkeySignerFor(SQUADS_ENVIRONMENT);
}

export async function getRegistryFor(
  environment: DeployEnvironment,
): Promise<IRegistry> {
  return memoizeByEnvironment(registryPromises, environment, () =>
    getEnvironmentConfigFor(environment).then((envConfig) =>
      envConfig.getRegistry(),
    ),
  );
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
