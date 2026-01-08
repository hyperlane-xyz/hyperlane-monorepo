import { ethers } from 'ethers';

import {
  type AccountConfig,
  type ChainName,
  InterchainAccount,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, eqAddress } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { logBlue, logGreen, logRed, logTable, warnYellow } from '../logger.js';

interface IcaDeployParams {
  context: WriteCommandContext;
  origin: ChainName;
  destinations: ChainName[];
  owner: Address;
}

interface IcaDeployResult {
  chain: string;
  ica?: Address;
  status: 'deployed' | 'exists' | 'error';
  error?: string;
}

/**
 * Executes the ICA deploy command.
 * Deploys Interchain Accounts on destination chains for a specified owner on the origin chain.
 */
export async function runIcaDeploy(params: IcaDeployParams): Promise<void> {
  const { context, origin, destinations, owner } = params;
  const { registry, multiProvider } = context;

  // Validate owner address
  if (!ethers.utils.isAddress(owner)) {
    throw new Error(`Invalid owner address: ${owner}`);
  }

  logBlue(`Deploying ICAs for owner ${owner} on ${origin}...`);
  logBlue(`Destination chains: ${destinations.join(', ')}`);

  // Get chain addresses from the registry for all relevant chains
  const allChains = [origin, ...destinations];
  const chainAddresses: Record<string, Record<string, string>> = {};

  for (const chain of allChains) {
    const addresses = await registry.getChainAddresses(chain);
    if (!addresses) {
      throw new Error(
        `No addresses found in registry for chain ${chain}. Please deploy core contracts first.`,
      );
    }
    if (!addresses.interchainAccountRouter) {
      throw new Error(
        `No interchainAccountRouter address found for chain ${chain}. Please deploy ICA router first.`,
      );
    }
    chainAddresses[chain] = addresses;
  }

  // Create InterchainAccount instance from registry addresses
  const ica = InterchainAccount.fromAddressesMap(chainAddresses, multiProvider);

  const ownerConfig: AccountConfig = {
    origin,
    owner,
  };

  // Deploy ICAs on each destination chain in parallel
  const settledResults = await Promise.allSettled(
    destinations.map(async (destination) => {
      // First, get the expected ICA address
      const expectedAccount = await ica.getAccount(destination, ownerConfig);

      // Check if ICA already exists by checking if there's code at the address
      const provider = multiProvider.getProvider(destination);
      const code = await provider.getCode(expectedAccount);
      const exists = code !== '0x';

      if (exists) {
        logBlue(`ICA already exists on ${destination}: ${expectedAccount}`);
        return {
          chain: destination,
          ica: expectedAccount,
          status: 'exists' as const,
        };
      }

      // Deploy the ICA
      logBlue(`Deploying ICA on ${destination}...`);
      const deployedAccount = await ica.deployAccount(destination, ownerConfig);

      assert(
        eqAddress(deployedAccount, expectedAccount),
        `Deployed ICA address ${deployedAccount} does not match expected address ${expectedAccount}`,
      );

      logGreen(`ICA deployed on ${destination}: ${deployedAccount}`);
      return {
        chain: destination,
        ica: deployedAccount,
        status: 'deployed' as const,
      };
    }),
  );

  // Process settled results
  const results: IcaDeployResult[] = settledResults.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const destination = destinations[index];
    const errorMessage =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
    logRed(`Failed to deploy ICA on ${destination}: ${errorMessage}`);
    return {
      chain: destination,
      status: 'error',
      error: errorMessage,
    };
  });

  // Display results table
  logBlue('\nICA Deployment Results:');
  logTable(
    results.map(({ chain, ica, status, error }) => ({
      chain,
      ica: ica ?? 'N/A',
      status,
      ...(error ? { error } : {}),
    })),
  );

  // Summary
  const deployed = results.filter((r) => r.status === 'deployed').length;
  const existing = results.filter((r) => r.status === 'exists').length;
  const errors = results.filter((r) => r.status === 'error').length;

  if (deployed > 0) {
    logGreen(`Successfully deployed ${deployed} ICA(s)`);
  }
  if (existing > 0) {
    warnYellow(`${existing} ICA(s) already existed`);
  }
  if (errors > 0) {
    logRed(`${errors} ICA deployment(s) failed`);
  }
}
