import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import { TimelockController__factory } from '@hyperlane-xyz/core';
import {
  CANCELLER_ROLE,
  ChainMap,
  ChainName,
  EXECUTOR_ROLE,
  EvmTimelockReader,
  MultiProvider,
  PROPOSER_ROLE,
  TimelockConfig,
  getTimelockExecutableTransactionFromBatch,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  HexString,
  assert,
  eqAddress,
  isObjEmpty,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

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

const rpcBlockRangesByChain: ChainMap<number> = {
  // The rpc limits to a max of 1024 blocks
  moonbeam: 1024,
  // The rpc limits to a max of 5000 blocks
  merlin: 5000,
  // The rpc limits to a max of 1000 blocks
  xlayer: 1000,
  // The rpc limits to a max of 1000 blocks
  dogechain: 5000,
};

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

const TX_FETCH_RETRIES = 5;
const TX_FETCH_RETRY_DELAY = 5000;

export enum TimelockOperationStatus {
  PENDING = '🟡',
  READY_TO_EXECUTE = '🟢',
}

type TimelockTransactionStatus = {
  chain: ChainName;
  id: string;
  earliestExecution: BigNumber;
  executeTransactionData: HexString;
  predecessorId: HexString;
  salt: HexString;
  timelockAddress: Address;
  status: TimelockOperationStatus;
  canSignerExecute: boolean;
};

async function getPendingTimelockTxsOnChain(
  chain: ChainName,
  timelockAddress: Address,
  multiProvider: MultiProvider,
): Promise<TimelockTransactionStatus[] | undefined> {
  const reader = EvmTimelockReader.fromConfig({
    chain,
    multiProvider,
    timelockAddress,
    paginationBlockRange: rpcBlockRangesByChain[chain] ?? 10_000,
  });

  let scheduledTxs: Awaited<
    ReturnType<EvmTimelockReader['getPendingScheduledOperations']>
  >;
  try {
    scheduledTxs = await retryAsync(
      () => reader.getPendingScheduledOperations(),
      TX_FETCH_RETRIES,
      TX_FETCH_RETRY_DELAY,
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to fetch pending transactions for Timelock "${timelockAddress}" on ${chain} after ${TX_FETCH_RETRIES} attempts: ${error}`,
      ),
    );
    return;
  }

  if (!scheduledTxs || isObjEmpty(scheduledTxs)) {
    rootLogger.info(
      chalk.gray.italic(
        `No pending transactions found for Timelock ${timelockAddress} on ${chain}`,
      ),
    );
    return;
  }

  const scheduledTxIds = Object.keys(scheduledTxs);
  const [readyTransactionIds, canSignerExecute] = await Promise.all([
    reader.getReadyOperationIds(scheduledTxIds),
    reader.canExecuteOperations(await multiProvider.getSignerAddress(chain)),
  ]);

  return Promise.all(
    Object.values(scheduledTxs).map(
      async (tx): Promise<TimelockTransactionStatus> => {
        const timelockController = TimelockController__factory.connect(
          timelockAddress,
          multiProvider.getProvider(chain),
        );
        const earliestExecution = await timelockController.getTimestamp(tx.id);
        return {
          chain,
          earliestExecution,
          canSignerExecute,
          executeTransactionData: getTimelockExecutableTransactionFromBatch(tx),
          id: tx.id,
          predecessorId: tx.predecessor,
          salt: tx.salt,
          status: !readyTransactionIds.has(tx.id)
            ? TimelockOperationStatus.PENDING
            : TimelockOperationStatus.READY_TO_EXECUTE,
          timelockAddress,
        };
      },
    ),
  );
}

export async function getPendingTimelockTxs(
  chains: ChainName[],
  multiProvider: MultiProvider,
  timelocks: ChainMap<Address>,
): Promise<TimelockTransactionStatus[]> {
  const timelockTransactions: ChainMap<TimelockTransactionStatus[]> = {};

  await Promise.all(
    chains.map(async (chain) => {
      const timelockAddress = timelocks[chain];

      if (!timelockAddress) {
        rootLogger.info(
          chalk.gray.italic(
            `Skipping chain ${chain} as it does not have a Timelock deployment`,
          ),
        );
        return;
      }

      const maybeTxs = await getPendingTimelockTxsOnChain(
        chain,
        timelockAddress,
        multiProvider,
      );

      if (!maybeTxs) {
        return;
      }

      timelockTransactions[chain] = maybeTxs;
    }),
  );

  return Object.values(timelockTransactions).flatMap((txs) => txs);
}

export async function deleteTimelockTx(
  chain: ChainName,
  timelockAddress: Address,
  operationId: HexString,
  multiProvider: MultiProvider,
): Promise<void> {
  const timelockInstance = TimelockController__factory.connect(
    timelockAddress,
    multiProvider.getSigner(chain),
  );

  const isPendingOperation =
    await timelockInstance.isOperationPending(operationId);
  if (!isPendingOperation) {
    rootLogger.error(
      `Timelock operation with id ${operationId} on chain ${chain} does not exist or is not pending`,
    );
    return;
  }

  const signerAddress = await multiProvider.getSignerAddress(chain);
  const canCancel = await timelockInstance.hasRole(
    CANCELLER_ROLE,
    signerAddress,
  );
  if (!canCancel) {
    rootLogger.error(
      `Current signer "${signerAddress}" does not have permission to cancel transaction on timelock "${timelockAddress}" on chain "${chain}"`,
    );
    return;
  }

  const cancelTx = await timelockInstance.cancel(operationId);
  await cancelTx.wait();

  rootLogger.info(
    `Successfully cancelled timelock operation "${operationId}" on chain ${chain} at tx "${cancelTx.hash}"`,
  );
}

export async function cancelAllTimelockTxs(
  chains: ChainName[],
  timelocks: ChainMap<Address>,
  multiProvider: MultiProvider,
): Promise<void> {
  await Promise.all(
    chains.map(async (chain) => {
      const timelockAddress = timelocks[chain];

      if (!timelockAddress) {
        rootLogger.info(
          chalk.gray.italic(
            `Skipping chain ${chain} as it does not have a Timelock deployment`,
          ),
        );
        return;
      }

      try {
        const maybePendingTxs = await getPendingTimelockTxsOnChain(
          chain,
          timelockAddress,
          multiProvider,
        );

        if (!maybePendingTxs) {
          return;
        }

        for (const { id } of maybePendingTxs) {
          await deleteTimelockTx(chain, timelockAddress, id, multiProvider);
        }
      } catch (err) {
        rootLogger.error(
          `Error deleting pending transactions for Timelock "${timelockAddress}" on "${chain}":`,
          err,
        );
      }
    }),
  );
}
