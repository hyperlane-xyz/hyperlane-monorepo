import { ethers } from 'ethers';
import { Logger } from 'pino';
import { Log, getAbiItem, parseEventLogs, toEventSelector } from 'viem';

import { IXERC20Lockbox__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import {
  GetEventLogsResponse,
  getContractDeploymentTransaction,
  getLogsFromEtherscanLikeExplorerAPI,
} from '../block-explorer/etherscan.js';
import { ExplorerFamily } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import { XERC20TokenExtraLockboxLimits } from './types.js';

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
}: GetExtraLockboxesOptions): Promise<XERC20TokenExtraLockboxLimits[]> {
  const { apiUrl, family, apiKey } = multiProvider.getExplorerApi(chain);

  // Fallback to use the rpc if the user has not provided an API key and the explorer family is Etherscan
  // because the endpoint requires it or the explorer family is not known
  const isExplorerConfiguredCorrectly =
    family === ExplorerFamily.Etherscan ? !!apiKey : true;
  const canUseExplorerApi =
    family !== ExplorerFamily.Other && isExplorerConfiguredCorrectly;

  const provider = multiProvider.getProvider(chain);
  let startBlock = 0;
  if (canUseExplorerApi) {
    const contractDeploymentTx = await getContractDeploymentTransaction(
      { apiUrl, apiKey: apiKey },
      { contractAddress: xERC20Address },
    );

    const deploymentTransactionReceipt = await provider.getTransactionReceipt(
      contractDeploymentTx.txHash,
    );

    startBlock = deploymentTransactionReceipt.blockNumber;
  }

  const currentBlockNumber = await provider.getBlockNumber();

  const eventTopic = toEventSelector(
    getAbiItem({
      abi: minimalXERC20VSABI,
      name: 'ConfigurationChanged',
    }),
  );

  let logs: (ethers.providers.Log | GetEventLogsResponse)[];
  if (canUseExplorerApi) {
    logs = await getLogsFromEtherscanLikeExplorerAPI(
      { apiUrl, apiKey: apiKey },
      {
        address: xERC20Address,
        fromBlock: startBlock,
        toBlock: currentBlockNumber,
        topic0: eventTopic,
      },
    );
  } else {
    logger.debug(
      `Using rpc request to retrieve bridges on on lockbox contract ${xERC20Address} on chain ${chain}`,
    );

    // Should be safe to use even with public RPCs as the total number of events in this topic should be low
    logs = await provider.getLogs({
      address: xERC20Address,
      fromBlock: startBlock,
      toBlock: currentBlockNumber,
      topics: [eventTopic],
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
): Promise<XERC20TokenExtraLockboxLimits[]> {
  const parsedLogs = parseEventLogs({
    abi: minimalXERC20VSABI,
    eventName: 'ConfigurationChanged',
    logs,
  });

  const dedupedBridges = parsedLogs.reduce((acc, log) => {
    if (log.blockNumber > (acc[log.args.bridge]?.blockNumber ?? 0n)) {
      acc[log.args.bridge] = log;
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
