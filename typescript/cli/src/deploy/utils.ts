import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  IsmConfig,
  MultisigConfig,
  getLocalProvider,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { parseIsmConfig } from '../config/ism.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logGreen, logPink } from '../logger.js';
import { gasBalancesAreSufficient } from '../utils/balances.js';
import { ENV } from '../utils/env.js';
import { assertSigner } from '../utils/keys.js';

import { completeDryRun } from './dry-run.js';

export async function runPreflightChecks({
  context,
  origin,
  remotes,
  minGas,
  chainsToGasCheck,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  remotes: ChainName[];
  minGas: string;
  chainsToGasCheck?: ChainName[];
}) {
  log('Running pre-flight checks...');

  if (!origin || !remotes?.length) throw new Error('Invalid chain selection');
  logGreen('✅ Chain selections are valid');

  if (remotes.includes(origin))
    throw new Error('Origin and remotes must be distinct');
  logGreen('✅ Origin and remote are distinct');

  return runPreflightChecksForChains({
    context,
    chains: [origin, ...remotes],
    minGas,
    chainsToGasCheck,
  });
}

export async function runPreflightChecksForChains({
  context,
  chains,
  minGas,
  chainsToGasCheck,
}: {
  context: WriteCommandContext;
  chains: ChainName[];
  minGas: string;
  // Chains for which to assert a native balance
  // Defaults to all chains if not specified
  chainsToGasCheck?: ChainName[];
}) {
  log('Running pre-flight checks for chains...');
  const { signer, multiProvider } = context;

  if (!chains?.length) throw new Error('Empty chain selection');
  for (const chain of chains) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    if (!metadata) throw new Error(`No chain config found for ${chain}`);
    if (metadata.protocol !== ProtocolType.Ethereum)
      throw new Error('Only Ethereum chains are supported for now');
  }
  logGreen('✅ Chains are valid');

  assertSigner(signer);
  logGreen('✅ Signer is valid');

  const sufficient = await gasBalancesAreSufficient(
    multiProvider,
    signer,
    chainsToGasCheck ?? chains,
    minGas,
  );
  if (sufficient) logGreen('✅ Balances are sufficient');
}

// from parsed types
export function isISMConfig(
  config: ChainMap<MultisigConfig> | ChainMap<IsmConfig>,
): boolean {
  return Object.values(config).some((c) => 'type' in c);
}

// directly from filepath
export function isZODISMConfig(filepath: string): boolean {
  return parseIsmConfig(filepath).success;
}

export async function prepareDeploy(
  context: WriteCommandContext,
  userAddress: Address,
  chains: ChainName[],
): Promise<Record<string, BigNumber>> {
  const { multiProvider, isDryRun } = context;
  const initialBalances: Record<string, BigNumber> = {};
  await Promise.all(
    chains.map(async (chain: ChainName) => {
      const provider = isDryRun
        ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
        : multiProvider.getProvider(chain);
      const currentBalance = await provider.getBalance(userAddress);
      initialBalances[chain] = currentBalance;
    }),
  );
  return initialBalances;
}

export async function completeDeploy(
  context: WriteCommandContext,
  command: string,
  initialBalances: Record<string, BigNumber>,
  userAddress: Address,
  chains: ChainName[],
) {
  const { multiProvider, isDryRun } = context;
  if (chains.length > 0) logPink(`⛽️ Gas Usage Statistics`);
  for (const chain of chains) {
    const provider = isDryRun
      ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
      : multiProvider.getProvider(chain);
    const currentBalance = await provider.getBalance(userAddress);
    const balanceDelta = initialBalances[chain].sub(currentBalance);
    if (isDryRun && balanceDelta.lt(0)) break;
    logPink(
      `\t- Gas required for ${command} ${
        isDryRun ? 'dry-run' : 'deploy'
      } on ${chain}: ${ethers.utils.formatEther(balanceDelta)} ${
        multiProvider.getChainMetadata(chain).nativeToken?.symbol
      }`,
    );
  }

  if (isDryRun) await completeDryRun(command);
}

export function toUpperCamelCase(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
