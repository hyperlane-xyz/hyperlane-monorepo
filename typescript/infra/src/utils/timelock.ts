import { ethers } from 'ethers';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import {
  CANCELLER_ROLE,
  ChainMap,
  ChainName,
  EXECUTOR_ROLE,
  MultiProvider,
  PROPOSER_ROLE,
  TimelockConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert, eqAddress } from '@hyperlane-xyz/utils';

import { DEPLOYER } from '../../config/environments/mainnet3/owners.js';

export const DEFAULT_TIMELOCK_DELAY_SECONDS = 60 * 60 * 24 * 1; // 1 day

export async function timelockConfigMatches({
  multiProvider,
  chain,
  expectedConfig,
  address,
}: {
  multiProvider: MultiProvider;
  chain: ChainName;
  expectedConfig: TimelockConfig;
  address?: string;
}): Promise<{ matches: boolean; issues: string[] }> {
  const issues: string[] = [];

  if (!address) {
    issues.push(`Timelock address not found for ${chain}`);
  } else {
    const timelock = TimelockController__factory.connect(
      address,
      multiProvider.getProvider(chain),
    );

    // Ensure the min delay is set to the expected value
    const minDelay = await timelock.getMinDelay();
    if (!minDelay.eq(expectedConfig.minimumDelay)) {
      issues.push(
        `Min delay mismatch for ${chain} at ${address}: actual delay ${minDelay.toNumber()} !== expected delay ${expectedConfig.minimumDelay}`,
      );
    }

    // Ensure the executors have the EXECUTOR_ROLE
    const expectedExecutors =
      expectedConfig.executors && expectedConfig.executors.length !== 0
        ? expectedConfig.executors
        : [ethers.constants.AddressZero];
    const executorRoles = await Promise.all(
      expectedExecutors.map(async (executor) => {
        return timelock.hasRole(EXECUTOR_ROLE, executor);
      }),
    );
    const executorsMissing = expectedExecutors.filter(
      (_, i) => !executorRoles[i],
    );
    if (executorsMissing.length > 0) {
      issues.push(
        `Executors missing role for ${chain} at ${address}: ${executorsMissing.join(', ')}`,
      );
    }

    // Ensure the proposers have the PROPOSER_ROLE
    const proposerRoles = await Promise.all(
      expectedConfig.proposers.map(async (proposer) => {
        return timelock.hasRole(PROPOSER_ROLE, proposer);
      }),
    );
    const proposersMissing = expectedConfig.proposers.filter(
      (_, i) => !proposerRoles[i],
    );
    if (proposersMissing.length > 0) {
      issues.push(
        `Proposers missing role for ${chain} at ${address}: ${proposersMissing.join(', ')}`,
      );
    }

    // Ensure the cancellers have the CANCELLER_ROLE
    // by default proposers are also cancellers
    const expectedCancellers =
      expectedConfig.cancellers && expectedConfig.cancellers.length !== 0
        ? expectedConfig.cancellers
        : expectedConfig.proposers;
    const cancellerRoles = await Promise.all(
      expectedCancellers.map(async (canceller) => {
        return timelock.hasRole(CANCELLER_ROLE, canceller);
      }),
    );
    const cancellerMissing = expectedCancellers.filter(
      (_, i) => !cancellerRoles[i],
    );
    if (cancellerMissing.length > 0) {
      issues.push(
        `Canceller missing role for ${chain} at ${address}: ${cancellerMissing.join(', ')}`,
      );
    }

    // Ensure the proposers that are not in the cancellers array
    // do not have the CANCELLER_ROLE
    const proposersWithExtraRole: string[] = [];
    await Promise.all(
      expectedConfig.proposers.map(async (proposer) => {
        const proposerIsNotCanceller = !expectedCancellers.some((canceller) =>
          eqAddress(canceller, proposer),
        );
        if (proposerIsNotCanceller) {
          const hasRole = await timelock.hasRole(CANCELLER_ROLE, proposer);
          if (hasRole) {
            proposersWithExtraRole.push(proposer);
          }
        }
      }),
    );

    if (proposersWithExtraRole.length > 0) {
      issues.push(
        `Proposers that should not be cancellers for ${chain} at ${address}: ${proposersWithExtraRole.join(', ')}`,
      );
    }
  }

  return { matches: issues.length === 0, issues };
}

export function getTimelockConfigs({
  chains,
  owners,
}: {
  chains: ChainName[];
  owners: ChainMap<Address>;
}): ChainMap<TimelockConfig> {
  const timelockConfigs: ChainMap<TimelockConfig> = {};

  // Configure timelocks for the given chains
  chains.forEach((chain) => {
    const owner = owners[chain];
    assert(owner, `No owner found for ${chain}`);

    timelockConfigs[chain] = {
      minimumDelay: DEFAULT_TIMELOCK_DELAY_SECONDS,
      proposers: [owner],
      cancellers: [DEPLOYER],
    };
  });

  return timelockConfigs;
}
