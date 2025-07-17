import { TimelockController__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  EXECUTOR_ROLE,
  MultiProvider,
  PROPOSER_ROLE,
  TimelockConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

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
}): Promise<boolean> {
  if (!address) {
    rootLogger.debug(`Timelock address not found for ${chain}`);
    return false;
  }

  const timelock = TimelockController__factory.connect(
    address,
    multiProvider.getProvider(chain),
  );

  const minDelay = await timelock.getMinDelay();
  if (!minDelay.eq(expectedConfig.minimumDelay)) {
    rootLogger.debug(
      `Min delay mismatch for ${chain} at ${address}: actual delay ${minDelay.toNumber()} !== expected delay ${expectedConfig.minimumDelay}`,
    );
    return false;
  }

  const executorRoles = await Promise.all(
    expectedConfig.executors.map(async (executor) => {
      return timelock.hasRole(EXECUTOR_ROLE, executor);
    }),
  );
  const executorsMissing = executorRoles.filter((role) => !role);
  if (executorsMissing.length > 0) {
    rootLogger.debug(
      `Executors missing role for ${chain} at ${address}: ${executorsMissing.join(
        ', ',
      )}`,
    );
    return false;
  }

  const proposerRoles = await Promise.all(
    expectedConfig.proposers.map(async (proposer) => {
      return timelock.hasRole(PROPOSER_ROLE, proposer);
    }),
  );
  const proposersMissing = proposerRoles.filter((role) => !role);
  if (proposersMissing.length > 0) {
    rootLogger.debug(
      `Proposers missing role for ${chain} at ${address}: ${proposersMissing.join(
        ', ',
      )}`,
    );
    return false;
  }

  return true;
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
      executors: [DEPLOYER],
    };
  });

  return timelockConfigs;
}
