import { ethers } from 'ethers';
import { Logger } from 'pino';
import { Log, getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { IXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger, sleep } from '@hyperlane-xyz/utils';

import {
  GetEventLogsResponse,
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from '../block-explorer/etherscan.js';
import { ExplorerFamily } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import { XERC20TokenExtraBridgesLimits } from './types.js';

const minimalXERC20VSABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'bridge',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint112',
        name: 'bufferCap',
        type: 'uint112',
      },
      {
        indexed: false,
        internalType: 'uint128',
        name: 'rateLimitPerSecond',
        type: 'uint128',
      },
    ],
    name: 'ConfigurationChanged',
    type: 'event',
  },
] as const;

const CONFIGURATION_CHANGED_EVENT_SELECTOR = toEventSelector(
  getAbiItem({
    abi: minimalXERC20VSABI,
    name: 'ConfigurationChanged',
  }),
);

export type GetExtraLockboxesOptions = {
  chain: ChainNameOrId;
  xERC20Address: Address;
  multiProvider: MultiProvider;
  logger?: Logger;
};

export async function getExtraLockBoxConfigs({
  xERC20Address,
  chain,
  multiProvider,
  logger = rootLogger,
}: GetExtraLockboxesOptions): Promise<XERC20TokenExtraBridgesLimits[]> {
  const { family, apiKey } = multiProvider.getExplorerApi(chain);

  // Fallback to use the rpc if the user has not provided an API key and the explorer family is Etherscan
  // because the endpoint requires it or the explorer family is not known
  const isExplorerConfiguredCorrectly =
    family === ExplorerFamily.Etherscan ? !!apiKey : true;
  const canUseExplorerApi =
    family !== ExplorerFamily.Other && isExplorerConfiguredCorrectly;

  const provider = multiProvider.getProvider(chain);
  let logs: (ethers.providers.Log | GetEventLogsResponse)[];
  if (canUseExplorerApi) {
    logs = await getConfigurationChangedLogsFromExplorerApi({
      chain,
      multiProvider,
      xERC20Address,
    });
  } else {
    logger.debug(
      `Using rpc request to retrieve bridges on on lockbox contract ${xERC20Address} on chain ${chain}`,
    );

    // Should be safe to use even with public RPCs as the total number of events in this topic should be low
    logs = await getConfigurationChangedLogsFromRpc({
      chain,
      multiProvider,
      xERC20Address,
    });
  }

  const viemLogs = logs.map(
    (log) =>
      ({
        address: log.address,
        data: log.data,
        blockNumber: BigInt(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        transactionIndex: Number(log.transactionIndex),
        topics: log.topics,
      } as Log),
  );

  return getLockboxesFromLogs(viemLogs, provider, chain, logger);
}

async function getConfigurationChangedLogsFromExplorerApi({
  xERC20Address,
  chain,
  multiProvider,
}: GetExtraLockboxesOptions): Promise<Array<GetEventLogsResponse>> {
  const { apiUrl, apiKey } = multiProvider.getExplorerApi(chain);

  const contractDeploymentTx = await getContractDeploymentTransaction(
    { apiUrl, apiKey },
    { contractAddress: xERC20Address },
  );

  const provider = multiProvider.getProvider(chain);
  const [currentBlockNumber, deploymentTransactionReceipt] = await Promise.all([
    provider.getBlockNumber(),
    provider.getTransactionReceipt(contractDeploymentTx.txHash),
  ]);

  return getLogsFromEtherscanLikeExplorerAPI(
    { apiUrl, apiKey },
    {
      address: xERC20Address,
      fromBlock: deploymentTransactionReceipt.blockNumber,
      toBlock: currentBlockNumber,
      topic0: CONFIGURATION_CHANGED_EVENT_SELECTOR,
    },
  );
}

async function getConfigurationChangedLogsFromRpc({
  xERC20Address,
  chain,
  multiProvider,
}: GetExtraLockboxesOptions): Promise<Array<ethers.providers.Log>> {
  const provider = multiProvider.getProvider(chain);

  const endBlock = await provider.getBlockNumber();
  let currentStartBlock = await getContractCreationBlockFromRpc(
    xERC20Address,
    provider,
  );

  const logs = [];
  const range = 5000;
  while (currentStartBlock < endBlock) {
    const currentLogs = await provider.getLogs({
      address: xERC20Address,
      fromBlock: currentStartBlock,
      toBlock: currentStartBlock + range,
      topics: [CONFIGURATION_CHANGED_EVENT_SELECTOR],
    });
    logs.push(...currentLogs);
    currentStartBlock += range;

    // Sleep to avoid being rate limited with public RPCs
    await sleep(350);
  }

  return logs;
}

// Retrieves the contract deployment number by performing a binary search
// calling getCode until the creation block is found
async function getContractCreationBlockFromRpc(
  contractAddress: Address,
  provider: ethers.providers.Provider,
): Promise<number> {
  const latestBlock = await provider.getBlockNumber();
  const latestCode = await provider.getCode(contractAddress, latestBlock);
  if (latestCode === '0x') {
    throw new Error('Provided address is not a contract');
  }

  let low = 0;
  let high = latestBlock;
  let creationBlock = latestBlock;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(contractAddress, mid);

    if (code !== '0x') {
      creationBlock = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return creationBlock;
}

type ConfigurationChangedLog = Log<
  bigint,
  number,
  false,
  undefined,
  true,
  typeof minimalXERC20VSABI,
  'ConfigurationChanged'
>;

async function getLockboxesFromLogs(
  logs: Log[],
  provider: ethers.providers.Provider,
  chain: ChainNameOrId,
  logger: Logger,
): Promise<XERC20TokenExtraBridgesLimits[]> {
  const parsedLogs = parseEventLogs({
    abi: minimalXERC20VSABI,
    eventName: 'ConfigurationChanged',
    logs,
  });

  // A bridge might appear more than once in the event logs, we are only
  // interested in the most recent one for each bridge so we deduplicate
  // entries here
  const dedupedBridges = parsedLogs.reduce((acc, log) => {
    const bridgeAddress = log.args.bridge;
    const isMostRecentLogForBridge =
      log.blockNumber > (acc[bridgeAddress]?.blockNumber ?? 0n);

    if (isMostRecentLogForBridge) {
      acc[bridgeAddress] = log;
    }

    return acc;
  }, {} as Record<string, ConfigurationChangedLog>);

  const lockboxPromises = Object.values(dedupedBridges)
    // Removing bridges where the limits are set to 0 because it is equivalent of being deactivated
    .filter(
      (log) => log.args.bufferCap !== 0n && log.args.rateLimitPerSecond !== 0n,
    )
    .map(async (log) => {
      try {
        const maybeXERC20Lockbox = IXERC20Lockbox__factory.connect(
          log.args.bridge,
          provider,
        );

        await maybeXERC20Lockbox.callStatic.XERC20();
        return log;
      } catch {
        logger.debug(
          `Contract at address ${log.args.bridge} on chain ${chain} is not a XERC20Lockbox contract.`,
        );
        return undefined;
      }
    });

  const lockboxes = await Promise.all(lockboxPromises);
  return lockboxes
    .filter((log) => log !== undefined)
    .map((log) => log as ConfigurationChangedLog)
    .map((log) => ({
      lockbox: log.args.bridge,
      limits: {
        bufferCap: log.args.bufferCap.toString(),
        rateLimitPerSecond: log.args.rateLimitPerSecond.toString(),
      },
    }));
}
