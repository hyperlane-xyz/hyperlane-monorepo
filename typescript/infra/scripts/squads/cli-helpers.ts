import chalk from 'chalk';
import { PublicKey } from '@solana/web3.js';
import { Argv } from 'yargs';

import type { IRegistry } from '@hyperlane-xyz/registry';
import {
  MultiProtocolProvider,
  SquadProposalStatus,
  SquadsChainName,
  getSquadsChains,
  partitionSquadsChains,
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
const GENERIC_OBJECT_STRING_PATTERN = /^\[object .+\]$/;

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

  const formattedUnsupportedChains = Array.from(
    new Set(uniqueNonSquadsChains.map(formatChainNameForDisplay)),
  );
  const formattedConfiguredChains = Array.from(
    new Set(uniqueConfiguredSquadsChains.map(formatChainNameForDisplay)),
  );

  return (
    `Squads configuration not found for chains: ${formattedUnsupportedChains.join(', ')}. ` +
    `Available Squads chains: ${formattedConfiguredChains.join(', ')}`
  );
}

function formatChainNameForDisplay(chain: string): string {
  const trimmedChain = chain.trim();
  return trimmedChain.length > 0 ? trimmedChain : '<empty>';
}

export type NormalizeSolanaAddressValueResult =
  | { address: string; error: undefined }
  | { address: undefined; error: string };

export function normalizeSolanaAddressValue(
  value: unknown,
): NormalizeSolanaAddressValueResult {
  let rawAddressValue: string;

  if (typeof value === 'string') {
    rawAddressValue = value;
  } else {
    if (!value || typeof value !== 'object') {
      return {
        address: undefined,
        error: `expected string or object with toBase58(), got ${getArgTypeName(value)}`,
      };
    }

    const toBase58Candidate = (value as { toBase58?: unknown }).toBase58;
    if (typeof toBase58Candidate !== 'function') {
      return {
        address: undefined,
        error: 'missing toBase58() method',
      };
    }

    try {
      const toBase58Value = toBase58Candidate.call(value);
      rawAddressValue =
        typeof toBase58Value === 'string'
          ? toBase58Value
          : String(toBase58Value);
    } catch (error) {
      return {
        address: undefined,
        error: `failed to stringify key (${formatScriptError(error)})`,
      };
    }
  }

  const trimmedAddressValue = rawAddressValue.trim();
  if (trimmedAddressValue.length === 0) {
    return {
      address: undefined,
      error: 'address value is empty',
    };
  }

  if (GENERIC_OBJECT_STRING_PATTERN.test(trimmedAddressValue)) {
    return {
      address: undefined,
      error: 'address value is not a meaningful identifier',
    };
  }

  try {
    return {
      address: new PublicKey(trimmedAddressValue).toBase58(),
      error: undefined,
    };
  } catch {
    return {
      address: undefined,
      error: 'address value is not a valid Solana address',
    };
  }
}

export function resolveSquadsChains(
  chains?: readonly unknown[],
): SquadsChainName[] {
  const configuredSquadsChains = getSquadsChains();
  if (chains && chains.length > 0) {
    const normalizedChains = normalizeProvidedChains(chains);
    const { squadsChains, nonSquadsChains } =
      partitionSquadsChains(normalizedChains);
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
  return [...configuredSquadsChains];
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
    return error.stack ?? error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    try {
      return stringifyObject(error);
    } catch {
      return '[unformattable error object]';
    }
  }

  return String(error);
}
