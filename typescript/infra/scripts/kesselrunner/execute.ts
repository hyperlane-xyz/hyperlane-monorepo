import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';

import { ChainMap, ChainName, HyperlaneCore } from '@hyperlane-xyz/sdk';
import {
  addBufferToGasLimit,
  addressToBytes32,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  KESSEL_RUN_CONFIG,
  KESSEL_RUN_HOURLY_RATE,
} from '../../src/kesselrunner/config.js';
import { getKesselRunMultiProvider } from '../../src/kesselrunner/utils.js';

const testRecipient = '0x492b3653A38e229482Bab2f7De4A094B18017246';
// 64 bytes
const body = "It's the ship that made the Kessel Run in less than 12 parsecs!!";
const DEFAULT_METADATA = '0x0001';

async function preCalculateGasEstimates(
  core: HyperlaneCore,
  origins: string[],
  destinations: string[],
) {
  const gasEstimates: Record<string, Record<string, ethers.BigNumber>> = {};
  rootLogger.info('Starting gas estimate pre-calculation');
  const startTime = Date.now();

  for (const origin of origins) {
    gasEstimates[origin] = {};
    for (const destination of destinations) {
      if (origin === destination) continue;

      rootLogger.debug(
        `Calculating gas estimate from ${origin} to ${destination}`,
      );
      const messageBody = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(body));
      const mailbox = core.getContracts(origin).mailbox;
      const destinationDomain = core.multiProvider.getDomainId(destination);
      const recipientBytes32 = addressToBytes32(testRecipient);
      const quote = await core.quoteGasPayment(
        origin,
        destination,
        recipientBytes32,
        messageBody,
      );

      const dispatchParams = [
        destinationDomain,
        recipientBytes32,
        messageBody,
        DEFAULT_METADATA,
        ethers.constants.AddressZero,
      ] as const;

      const estimateGas = await mailbox.estimateGas[
        'dispatch(uint32,bytes32,bytes,bytes,address)'
      ](...dispatchParams, { value: quote });

      gasEstimates[origin][destination] = estimateGas;
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
  return gasEstimates;
}

async function sendTestMessage({
  origin,
  destination,
  core,
  nonce,
  gasEstimate,
}: {
  origin: ChainName;
  destination: ChainName;
  core: HyperlaneCore;
  nonce: number;
  gasEstimate: ethers.BigNumber;
}) {
  try {
    const messageBody = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(body));
    const mailbox = core.getContracts(origin).mailbox;
    const destinationDomain = core.multiProvider.getDomainId(destination);
    const recipientBytes32 = addressToBytes32(testRecipient);
    const quote = await core.quoteGasPayment(
      origin,
      destination,
      recipientBytes32,
      messageBody,
    );

    const dispatchParams = [
      destinationDomain,
      recipientBytes32,
      messageBody,
      DEFAULT_METADATA,
      ethers.constants.AddressZero,
    ] as const;

    void mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
      ...dispatchParams,
      {
        ...core.multiProvider.getTransactionOverrides(origin),
        value: quote,
        gasLimit: addBufferToGasLimit(gasEstimate),
        nonce,
      },
    );
    rootLogger.info(
      chalk.italic.gray(`[${origin} ${nonce}] -> ${destination}`),
    );
    return;
  } catch (e) {
    rootLogger.info(chalk.bold.red(`[${origin} ${nonce}] -> ${destination}`));
    throw e;
  }
}

async function getNonces(
  multiProvider: any,
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
  const { multiProvider, targetNetworks, registry } =
    await getKesselRunMultiProvider();

  const chainAddresses = await registry.getAddresses();
  const filteredChainAddresses = Object.fromEntries(
    Object.entries(chainAddresses).filter(([chain]) =>
      targetNetworks.includes(chain),
    ),
  );

  const core = HyperlaneCore.fromAddressesMap(
    filteredChainAddresses,
    multiProvider,
  );

  const startingNonces = await getNonces(multiProvider, targetNetworks);
  rootLogger.info('Starting nonces:');
  // eslint-disable-next-line no-console
  console.table(startingNonces);

  const gasEstimates = await preCalculateGasEstimates(
    core,
    targetNetworks,
    targetNetworks,
  );

  for (let i = 0; i < KESSEL_RUN_CONFIG.bursts; i++) {
    rootLogger.info(`Starting burst ${i + 1} of ${KESSEL_RUN_CONFIG.bursts}`);

    const messageParams: Array<{
      origin: string;
      destination: string;
      core: typeof core;
      nonce: number;
      gasEstimate: BigNumber;
    }> = [];

    const messageCounts: Record<string, { from: number; to: number }> = {};

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
      ].includes(origin)
        ? KESSEL_RUN_CONFIG.distArbOp
        : KESSEL_RUN_CONFIG.distBaseBscEth;

      for (const [destination, bridgeDistribution] of Object.entries(
        distributionConfig,
      )) {
        const txCount = Math.max(
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

        for (let j = 0; j < txCount; j++) {
          if (origin === destination) {
            rootLogger.debug(`Skipping transaction from ${origin} to itself.`);
            continue;
          }
          messageParams.push({
            origin,
            destination,
            core,
            nonce,
            gasEstimate: gasEstimates[origin][destination],
          });
          nonce++;

          messageCounts[origin] = messageCounts[origin] || { from: 0, to: 0 };
          messageCounts[destination] = messageCounts[destination] || {
            from: 0,
            to: 0,
          };

          messageCounts[origin].from += 1;
          messageCounts[destination].to += 1;
        }
      }

      startingNonces[origin] = nonce;
    }

    const endTime = Date.now(); // End timing
    const duration = (endTime - startTime) / 1000; // Calculate duration in seconds
    rootLogger.info(`Finished preparing message params in ${duration}s`);

    // Calculate the total number of messages to send
    const totalBurstMsgCount = Object.values(messageCounts).reduce(
      (sum, count) => sum + count.from,
      0,
    );
    rootLogger.info(`Planning to send ${totalBurstMsgCount} messages`);
    // eslint-disable-next-line no-console
    console.table(messageCounts);

    await Promise.all(
      messageParams.map(async (params) => {
        try {
          await sendTestMessage(params);
          rootLogger.debug(
            `Sent message from ${params.origin} to ${params.destination} with nonce: ${params.nonce}`,
          );
        } catch (error) {
          rootLogger.error(
            chalk.bold.red(
              `Error sending message from ${params.origin} to ${params.destination} with nonce: ${params.nonce}:`,
              error,
            ),
          );
        }
      }),
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
