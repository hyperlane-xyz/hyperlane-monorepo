import chalk from 'chalk';
import { Argv } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  MultiProtocolProvider,
  SquadProposalStatus,
  SquadsChainName,
  getSquadsChains,
  normalizeStringifiedSquadsError,
  resolveSquadsChains as resolveSquadsChainsFromSdk,
  stringifyUnknownSquadsError,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger, stringifyObject } from '@hyperlane-xyz/utils';

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
    .coerce('transactionIndex', (transactionIndex: unknown) =>
      normalizeTransactionIndex(transactionIndex),
    )
    .demandOption('transactionIndex')
    .alias('t', 'transactionIndex');
}

export function withSquadsChain<T>(args: Argv<T>) {
  return args
    .describe('chain', 'chain name')
    .coerce('chain', (chain: unknown) => normalizeArgvSingleChain(chain))
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
    .coerce('chains', (selectedChains: unknown) =>
      Array.from(new Set(normalizeArgvChains(selectedChains))),
    )
    .alias('c', 'chains');
}

export function resolveSquadsChains(
  chains?: readonly unknown[],
): SquadsChainName[] {
  if (chains && chains.length > 0) {
    const normalizedChains = normalizeProvidedChains(chains);
    return resolveSquadsChainsFromSdk(normalizedChains);
  }
  return resolveSquadsChainsFromSdk();
}

function getArgTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

function normalizeArgvSingleChain(chain: unknown): string {
  assert(
    typeof chain === 'string',
    `Expected --chain to be a string, but received ${getArgTypeName(chain)}`,
  );

  const trimmedChain = chain.trim();
  assert(trimmedChain.length > 0, 'Expected --chain to be a non-empty string');
  return trimmedChain;
}

function normalizeChainValues(
  chains: readonly unknown[],
  argName: '--chains' | 'chains',
): string[] {
  return chains.map((chain, index) => {
    assert(
      typeof chain === 'string',
      `Expected ${argName}[${index}] to be a string, but received ${getArgTypeName(chain)}`,
    );
    const trimmedChain = chain.trim();
    assert(
      trimmedChain.length > 0,
      `Expected ${argName}[${index}] to be a non-empty string`,
    );
    return trimmedChain;
  });
}

function normalizeArgvChains(chains: unknown): string[] {
  if (typeof chains === 'undefined') {
    return [];
  }

  assert(
    Array.isArray(chains),
    `Expected --chains to resolve to an array, but received ${getArgTypeName(chains)}`,
  );

  return normalizeChainValues(chains, '--chains');
}

function normalizeProvidedChains(chains: readonly unknown[]): string[] {
  return normalizeChainValues(chains, 'chains');
}

function normalizeTransactionIndex(transactionIndex: unknown): number {
  assert(
    typeof transactionIndex === 'number',
    `Expected --transactionIndex to be a number, but received ${getArgTypeName(transactionIndex)}`,
  );
  assert(
    Number.isFinite(transactionIndex),
    `Expected --transactionIndex to be a finite number, but received ${String(transactionIndex)}`,
  );
  assert(
    Number.isSafeInteger(transactionIndex),
    `Expected --transactionIndex to be a safe integer, but received ${transactionIndex}`,
  );
  assert(
    transactionIndex >= 0,
    `Expected --transactionIndex to be a non-negative integer, but received ${transactionIndex}`,
  );
  return transactionIndex;
}

export function resolveSquadsChainsFromArgv(
  chains: unknown,
): SquadsChainName[] {
  return resolveSquadsChains(normalizeArgvChains(chains));
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

export function logProposals(
  pendingProposals: readonly SquadProposalStatus[],
): void {
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

export function formatScriptError(error: unknown): string {
  if (error instanceof Error) {
    return stringifyUnknownSquadsError(error, {
      preferErrorStackForErrorInstances: true,
      preferErrorMessageForErrorInstances: true,
      placeholder: '[unformattable error instance]',
    });
  }

  if (typeof error === 'string') {
    const normalizedError = normalizeStringifiedSquadsError(error);
    return normalizedError ?? '[unformattable error value]';
  }

  if (error && typeof error === 'object') {
    try {
      const stack = (error as { stack?: unknown }).stack;
      if (typeof stack === 'string') {
        const normalizedStack = normalizeStringifiedSquadsError(stack);
        if (normalizedStack) {
          return normalizedStack;
        }
      }
    } catch {}

    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        const normalizedMessage = normalizeStringifiedSquadsError(message);
        if (normalizedMessage) {
          return normalizedMessage;
        }
      }
    } catch {}

    try {
      return stringifyObject(error);
    } catch {}

    try {
      const normalizedError = normalizeStringifiedSquadsError(String(error));
      if (normalizedError) return normalizedError;
    } catch {}

    return '[unformattable error object]';
  }

  try {
    const normalizedError = normalizeStringifiedSquadsError(String(error));
    if (normalizedError) return normalizedError;
    return '[unformattable error value]';
  } catch {
    return '[unformattable error value]';
  }
}
