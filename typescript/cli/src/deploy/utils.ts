import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  IsmConfig,
  MultiProvider,
  MultisigConfig,
  getLocalProvider,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { Command } from '../commands/deploy.js';
import { parseIsmConfig } from '../config/ism.js';
import { log, logGreen, logPink } from '../logger.js';
import { assertGasBalances } from '../utils/balances.js';
import { ENV } from '../utils/env.js';
import { assertSigner } from '../utils/keys.js';

import { completeDryRun } from './dry-run.js';

export async function runPreflightChecks({
  origin,
  remotes,
  signer,
  multiProvider,
  minGas,
  chainsToGasCheck,
}: {
  origin: ChainName;
  remotes: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
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
    chains: [origin, ...remotes],
    signer,
    multiProvider,
    minGas,
    chainsToGasCheck,
  });
}

export async function runPreflightChecksForChains({
  chains,
  signer,
  multiProvider,
  minGas,
  chainsToGasCheck,
}: {
  chains: ChainName[];
  signer: ethers.Signer;
  multiProvider: MultiProvider;
  minGas: string;
  // Chains for which to assert a native balance
  // Defaults to all chains if not specified
  chainsToGasCheck?: ChainName[];
}) {
  log('Running pre-flight checks for chains...');

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

  await assertGasBalances(
    multiProvider,
    signer,
    chainsToGasCheck ?? chains,
    minGas,
  );
  logGreen('✅ Balances are sufficient');
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
  multiProvider: MultiProvider,
  userAddress: Address,
  chains: ChainName[],
  dryRun: boolean = false,
): Promise<Record<string, BigNumber>> {
  const initialBalances: Record<string, BigNumber> = {};
  await Promise.all(
    chains.map(async (chain: ChainName) => {
      const provider = dryRun
        ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
        : multiProvider.getProvider(chain);
      const currentBalance = await provider.getBalance(userAddress);
      initialBalances[chain] = currentBalance;
    }),
  );
  return initialBalances;
}

export async function completeDeploy(
  command: Command,
  initialBalances: Record<string, BigNumber>,
  multiProvider: MultiProvider,
  userAddress: Address,
  chains: ChainName[],
  dryRun: boolean = false,
) {
  if (chains.length > 0) logPink(`⛽️ Gas Usage Statistics`);
  for (const chain of chains) {
    const provider = dryRun
      ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
      : multiProvider.getProvider(chain);
    const currentBalance = await provider.getBalance(userAddress);
    const balanceDelta = initialBalances[chain].sub(currentBalance);
    if (dryRun && balanceDelta.lt(0)) break;
    logPink(
      `\t- Gas required for ${command} ${
        dryRun ? 'dry-run' : 'deploy'
      } on ${chain}: ${ethers.utils.formatEther(balanceDelta)} ${
        multiProvider.getChainMetadata(chain).nativeToken?.symbol
      }`,
    );
  }

  if (dryRun) await completeDryRun(command);
}

export function toUpperCamelCase(string: string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
