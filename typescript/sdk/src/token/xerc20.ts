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
import {
  BlockExplorer,
  ExplorerFamily,
} from '../metadata/chainMetadataTypes.js';
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
  explorerUrl: string;
  apiKey?: string;
  logger?: Logger;
};

function isEvmBlockExplorerAndNotEtherscan(
  blockExplorer: BlockExplorer,
): boolean {
  if (!blockExplorer.family) {
    return false;
  }

  const byFamily: Record<ExplorerFamily, boolean> = {
    [ExplorerFamily.Blockscout]: true,
    [ExplorerFamily.Etherscan]: false,
    [ExplorerFamily.Other]: false,
    [ExplorerFamily.Routescan]: true,
    [ExplorerFamily.Voyager]: false,
    [ExplorerFamily.ZkSync]: true,
  };

  return byFamily[blockExplorer.family] ?? false;
}

export async function getExtraLockBoxConfigs({
  xERC20Address,
  chain,
  multiProvider,
  logger = rootLogger,
}: Omit<GetExtraLockboxesOptions, 'explorerUrl' | 'apiKey'>): Promise<
  XERC20TokenExtraBridgesLimits[]
> {
  const defaultExplorer = multiProvider.getExplorerApi(chain);

  const chainMetadata = multiProvider.getChainMetadata(chain);
  const [fallBackExplorer] =
    chainMetadata.blockExplorers?.filter((blockExplorer) =>
      isEvmBlockExplorerAndNotEtherscan(blockExplorer),
    ) ?? [];

  // Fallback to use other block explorers if the default block explorer is etherscan and an API key is not
  // configured
  const isExplorerConfiguredCorrectly =
    defaultExplorer.family === ExplorerFamily.Etherscan
      ? !!defaultExplorer.apiKey
      : true;
  const canUseExplorerApi =
    defaultExplorer.family !== ExplorerFamily.Other &&
    isExplorerConfiguredCorrectly;

  const explorer = canUseExplorerApi ? defaultExplorer : fallBackExplorer;
  if (!explorer) {
    logger.warn(
      `No block explorer was configured correctly, skipping lockbox derivation on chain ${chain}`,
    );
    return [];
  }

  const logs = await getConfigurationChangedLogsFromExplorerApi({
    chain,
    multiProvider,
    xERC20Address,
    explorerUrl: explorer.apiUrl,
    apiKey: explorer.apiKey,
  });

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
      }) as Log,
  );

  return getLockboxesFromLogs(
    viemLogs,
    multiProvider.getProvider(chain),
    chain,
    logger,
  );
}

async function getConfigurationChangedLogsFromExplorerApi({
  xERC20Address,
  chain,
  multiProvider,
  explorerUrl,
  apiKey,
}: GetExtraLockboxesOptions): Promise<Array<GetEventLogsResponse>> {
  const contractDeploymentTx = await getContractDeploymentTransaction(
    { apiUrl: explorerUrl, apiKey },
    { contractAddress: xERC20Address },
  );

  const provider = multiProvider.getProvider(chain);
  const [currentBlockNumber, deploymentTransactionReceipt] = await Promise.all([
    provider.getBlockNumber(),
    provider.getTransactionReceipt(contractDeploymentTx.txHash),
  ]);

  return getLogsFromEtherscanLikeExplorerAPI(
    { apiUrl: explorerUrl, apiKey },
    {
      address: xERC20Address,
      fromBlock: deploymentTransactionReceipt.blockNumber,
      toBlock: currentBlockNumber,
      topic0: CONFIGURATION_CHANGED_EVENT_SELECTOR,
    },
  );
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
  const dedupedBridges = parsedLogs.reduce(
    (acc, log) => {
      const bridgeAddress = log.args.bridge;
      const isMostRecentLogForBridge =
        log.blockNumber > (acc[bridgeAddress]?.blockNumber ?? 0n);

      if (isMostRecentLogForBridge) {
        acc[bridgeAddress] = log;
      }

      return acc;
    },
    {} as Record<string, ConfigurationChangedLog>,
  );

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
