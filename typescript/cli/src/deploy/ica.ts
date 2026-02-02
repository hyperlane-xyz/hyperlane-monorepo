import {
  type AccountConfig,
  type ChainName,
  InterchainAccount,
  isContractAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  assert,
  eqAddress,
  isAddressEvm,
  mapAllSettled,
} from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { logBlue, logGreen, logRed, logTable, warnYellow } from '../logger.js';

export const IcaDeployStatus = {
  Deployed: 'deployed',
  Exists: 'exists',
  Error: 'error',
};

export type IcaDeployStatus =
  (typeof IcaDeployStatus)[keyof typeof IcaDeployStatus];

interface IcaDeployParams {
  context: WriteCommandContext;
  origin: ChainName;
  chains: ChainName[];
  owner: Address;
}

interface IcaDeployResult {
  chain: string;
  ica?: Address;
  status: IcaDeployStatus;
  error?: string;
}

/**
 * Executes the ICA deploy command.
 * Deploys Interchain Accounts on destination chains for a specified owner on the origin chain.
 */
export async function runIcaDeploy(params: IcaDeployParams): Promise<void> {
  const { context, origin, chains, owner } = params;
  const { registry, multiProvider } = context;

  // Validate owner address
  if (!isAddressEvm(owner)) {
    throw new Error(`Invalid owner address: ${owner}`);
  }

  logBlue(`Deploying ICAs for owner ${owner} on ${origin}...`);
  logBlue(`Destination chains: ${chains.join(', ')}`);

  // Get chain addresses from the registry for all relevant chains
  const allChains = [origin, ...chains];
  const chainAddresses: Record<ChainName, Record<string, string>> = {};

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
  const { fulfilled, rejected } = await mapAllSettled(
    chains,
    async (destination) => {
      // First, get the expected ICA address
      const expectedAccount = await ica.getAccount(destination, ownerConfig);

      // Check if ICA already exists
      const exists = await isContractAddress(
        multiProvider,
        destination,
        expectedAccount,
      );

      if (exists) {
        logBlue(`ICA already exists on ${destination}: ${expectedAccount}`);
        return {
          chain: destination,
          ica: expectedAccount,
          status: IcaDeployStatus.Exists,
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
        status: IcaDeployStatus.Deployed,
      };
    },
    (destination) => destination,
  );

  // Process settled results
  const results: IcaDeployResult[] = [
    ...fulfilled.values(),
    ...[...rejected.entries()].map(([destination, error]) => {
      logRed(`Failed to deploy ICA on ${destination}: ${error.message}`);
      return {
        chain: destination,
        status: IcaDeployStatus.Error,
        error: error.message,
      };
    }),
  ];

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
  const deployed = results.filter(
    (r) => r.status === IcaDeployStatus.Deployed,
  ).length;
  const existing = results.filter(
    (r) => r.status === IcaDeployStatus.Exists,
  ).length;
  const errors = results.filter(
    (r) => r.status === IcaDeployStatus.Error,
  ).length;

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
