import chalk from 'chalk';
import { ethers } from 'ethers';

import { HypERC20, HypERC20__factory } from '@hyperlane-xyz/core';
import { ChainMap, ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import {
  addBufferToGasLimit,
  addressToByteHexString,
  addressToBytes32,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  KESSEL_RUN_CONFIG,
  KESSEL_RUN_FUNDER_CONFIG,
  KESSEL_RUN_HOURLY_RATE,
  KESSEL_RUN_SPICE_ROUTE,
  MILLENNIUM_FALCON_ADDRESS,
} from '../../src/kesselrunner/config.js';
import { MILLENNIUM_FALCON_ABI } from '../../src/kesselrunner/consts.js';
import {
  PreparedMulticall,
  QueuedMulticall,
  TransferCall,
} from '../../src/kesselrunner/types.js';
import { getKesselRunMultiProvider } from '../../src/kesselrunner/utils.js';

const WARP_SEND = 1;

const gasCache: ChainMap<ChainMap<ethers.BigNumber>> = {};
const igpCache: ChainMap<ChainMap<ethers.BigNumber>> = {};
const hyperCache: ChainMap<HypERC20> = {};
const domainCache: ChainMap<number> = {};

const WARP_RECEIVER = addressToBytes32(
  addressToByteHexString(KESSEL_RUN_FUNDER_CONFIG.owner),
);

async function preCalculateGasEstimates(
  origins: string[],
  destinations: string[],
) {
  rootLogger.info('Starting gas estimate pre-calculation');
  const startTime = Date.now();

  for (const origin of origins) {
    gasCache[origin] = {};
    igpCache[origin] = {};
    for (const destination of destinations) {
      if (origin === destination) continue;

      rootLogger.debug(
        `Calculating gas estimate from ${origin} to ${destination}`,
      );

      const quote = await hyperCache[origin].quoteGasPayment(
        domainCache[destination],
      );
      igpCache[origin][destination] = quote;

      const estimateGas = await hyperCache[origin].estimateGas[
        'transferRemote(uint32,bytes32,uint256)'
      ](domainCache[destination], WARP_RECEIVER, WARP_SEND, {
        value: quote,
      });
      gasCache[origin][destination] = addBufferToGasLimit(estimateGas, 2);

      rootLogger.debug(
        `Gas estimate for ${origin} to ${destination}: ${estimateGas.toString()}`,
      );
    }
  }

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  rootLogger.info(
    `Completed gas estimate pre-calculation in ${duration} seconds`,
  );
}

async function prepareForLightSpeed(
  origin: ChainName,
  destination: ChainName,
  count: number,
): Promise<PreparedMulticall> {
  const value = igpCache[origin][destination];
  const totalValue = value.mul(count);
  const gasLimit = gasCache[origin][destination];
  const totalGasLimit = gasLimit.mul(count);

  const calls: TransferCall[] = [];

  for (let i = 0; i < count; i++) {
    calls.push({
      destination: domainCache[destination],
      recipient: WARP_RECEIVER,
      amount: ethers.BigNumber.from(WARP_SEND),
      value: value,
    });
  }

  const milleniumFalcon = new ethers.Contract(
    MILLENNIUM_FALCON_ADDRESS[origin],
    MILLENNIUM_FALCON_ABI,
  );
  const multiSendData = milleniumFalcon.interface.encodeFunctionData(
    'punchIt',
    [calls],
  );

  return {
    destination,
    to: MILLENNIUM_FALCON_ADDRESS[origin],
    data: multiSendData,
    value: totalValue,
    gasLimit: totalGasLimit,
  };
}

async function getNonces(
  multiProvider: MultiProvider,
  targetNetworks: string[],
): Promise<ChainMap<number>> {
  rootLogger.info('Fetching nonces for target networks');

  const nonces = await Promise.all(
    targetNetworks.map(async (chain) => {
      try {
        rootLogger.debug(`Fetching nonce for chain ${chain}`);
        const provider = multiProvider.getProvider(chain);
        const signerAddress = await multiProvider.getSignerAddress(chain);
        const nonce = await provider.getTransactionCount(signerAddress);
        rootLogger.debug(`Nonce for chain ${chain}: ${nonce}`);
        return { chain, nonce };
      } catch (error: any) {
        rootLogger.error(`Error fetching nonce for chain ${chain}:`, error);
        throw new Error(
          `Error fetching nonce for chain ${chain}: ${error.message}`,
        );
      }
    }),
  );

  const nonceMap = nonces.reduce((acc, { chain, nonce }) => {
    acc[chain] = nonce;
    return acc;
  }, {} as ChainMap<number>);

  rootLogger.info('Completed fetching nonces for target networks');
  rootLogger.debug('Nonces:', nonceMap);

  return nonceMap;
}

async function doTheKesselRun() {
  const { multiProvider, targetNetworks } = await getKesselRunMultiProvider();

  const startingNonces = await getNonces(multiProvider, targetNetworks);
  rootLogger.info('Starting nonces:');
  // eslint-disable-next-line no-console
  console.table(startingNonces);

  for (const [chainName, addressOrDenom] of Object.entries(
    KESSEL_RUN_SPICE_ROUTE,
  )) {
    assert(addressOrDenom, `Token address not found for chain ${chainName}`);
    hyperCache[chainName] = HypERC20__factory.connect(
      addressOrDenom,
      multiProvider.getSigner(chainName),
    );
    domainCache[chainName] = multiProvider.getDomainId(chainName);
  }

  await preCalculateGasEstimates(targetNetworks, targetNetworks);

  for (let i = 0; i < KESSEL_RUN_CONFIG.bursts; i++) {
    rootLogger.info(`Starting burst ${i + 1} of ${KESSEL_RUN_CONFIG.bursts}`);

    const burstInfo: Record<
      string,
      { txCount: number; from: number; to: number }
    > = {};
    const multicallMap: ChainMap<Array<QueuedMulticall>> = {};

    rootLogger.info('Preparing messageParams for burst');
    const startTime = Date.now(); // Start timing

    for (const origin of targetNetworks) {
      let nonce = startingNonces[origin];
      rootLogger.debug(
        `Processing origin: ${origin} with starting nonce: ${nonce}`,
      );

      const ratePerOrigin =
        KESSEL_RUN_HOURLY_RATE *
        KESSEL_RUN_CONFIG.distro[
          origin as keyof typeof KESSEL_RUN_CONFIG.distro
        ];

      const distributionConfig = [
        'arbitrumsepolia',
        'optimismsepolia',
        'arbitrum',
        'optimism',
      ].includes(origin)
        ? KESSEL_RUN_CONFIG.distArbOp
        : KESSEL_RUN_CONFIG.distBaseBscEth;

      for (const [destination, bridgeDistribution] of Object.entries(
        distributionConfig,
      )) {
        if (origin === destination) {
          rootLogger.debug(`Skipping transaction from ${origin} to itself.`);
          continue;
        }

        multicallMap[origin] = multicallMap[origin] || [];

        let txCount = Math.max(
          1,
          Math.floor(
            ratePerOrigin *
              bridgeDistribution *
              (KESSEL_RUN_CONFIG.burstInterval / 3600),
          ),
        );
        rootLogger.debug(
          `Origin: ${origin}, Destination: ${destination}, Transactions: ${txCount}`,
        );

        while (txCount > 0) {
          const batchSize = Math.min(
            txCount,
            KESSEL_RUN_CONFIG.multicallBatchSize,
          );
          txCount -= batchSize;

          const batch = await prepareForLightSpeed(
            origin,
            destination,
            batchSize,
          );

          multicallMap[origin].push({
            ...batch,
            nonce,
          });

          nonce++;

          if (!burstInfo[origin]) {
            burstInfo[origin] = { txCount: 0, from: 0, to: 0 };
          }
          if (!burstInfo[destination]) {
            burstInfo[destination] = { txCount: 0, from: 0, to: 0 };
          }

          // Update the message counts
          burstInfo[origin].txCount += 1;
          burstInfo[origin].from += batchSize;
          burstInfo[destination].to += batchSize;
        }
      }

      startingNonces[origin] = nonce;
    }

    const endTime = Date.now(); // End timing
    const duration = (endTime - startTime) / 1000; // Calculate duration in seconds
    rootLogger.info(`Finished preparing message params in ${duration}s`);

    // Calculate the total number of messages to send
    const totalBurstMsgCount = Object.values(burstInfo).reduce(
      (sum, count) => sum + count.from,
      0,
    );
    rootLogger.info(`Planning to send ${totalBurstMsgCount} messages`);
    // eslint-disable-next-line no-console
    console.table(burstInfo);

    // Prepare all transactions in a single array
    const allTransactions = targetNetworks.flatMap((origin) => {
      const multicallData = multicallMap[origin];
      const signer = multiProvider.getSigner(origin);
      return multicallData.map(
        ({ to, data, value, gasLimit, nonce, destination }) => ({
          signer,
          origin,
          to,
          data,
          value,
          gasLimit,
          nonce,
          destination,
        }),
      );
    });

    // Send all transactions
    await Promise.all(
      allTransactions.map(
        async ({
          signer,
          origin,
          to,
          data,
          value,
          gasLimit,
          nonce,
          destination,
        }) => {
          try {
            await signer.sendTransaction({
              to,
              data,
              value,
              gasLimit,
              nonce,
            });
            rootLogger.info(
              chalk.italic.gray(`[${origin} ${nonce}] -> ${destination}`),
            );
            rootLogger.debug(
              `Sent message from ${origin} to ${destination} with nonce: ${nonce}`,
            );
          } catch (error) {
            rootLogger.error(
              chalk.bold.red(`[${origin} ${nonce}] -> ${destination}`),
            );
            rootLogger.error(
              chalk.bold.red(
                `Error sending message from ${origin} to ${destination} with nonce: ${nonce}:`,
                error,
              ),
            );
          }
        },
      ),
    );

    rootLogger.info(`Completed burst ${i + 1}`);
    if (i < KESSEL_RUN_CONFIG.bursts - 1) {
      rootLogger.info(
        `Waiting for ${KESSEL_RUN_CONFIG.burstInterval}s before next burst`,
      );
      const interval = 5000; // 5 seconds in milliseconds
      let remainingTime = KESSEL_RUN_CONFIG.burstInterval;

      const intervalId = setInterval(() => {
        remainingTime -= interval;
        if (remainingTime > 0) {
          rootLogger.info(
            chalk.italic.gray(`Time until next burst: ${remainingTime}s`),
          );
        }
      }, interval);

      await new Promise<void>((resolve) =>
        setTimeout(() => {
          clearInterval(intervalId);
          resolve();
        }, KESSEL_RUN_CONFIG.burstInterval * 1000),
      );
    }
  }
}

doTheKesselRun().catch((error) => {
  rootLogger.error('Error doing the kessel run:', error);
  process.exit(1);
});
