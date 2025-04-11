import { ethers } from 'ethers';

import { ChainMap, ChainName, HyperlaneCore } from '@hyperlane-xyz/sdk';
import {
  addBufferToGasLimit,
  addressToBytes32,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  getKesselRunMultiProvider,
  kesselRunConfig,
} from '../../src/kesselrunner/config.js';

const testRecipient = '0x492b3653A38e229482Bab2f7De4A094B18017246';
const body = '<12parsecs';
const DEFAULT_METADATA = '0x0001';

async function sendTestMessage({
  origin,
  destination,
  core,
  nonce,
}: {
  origin: ChainName;
  destination: ChainName;
  core: HyperlaneCore;
  nonce: number;
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

    const estimateGas = await mailbox.estimateGas[
      'dispatch(uint32,bytes32,bytes,bytes,address)'
    ](...dispatchParams, { value: quote });

    void mailbox['dispatch(uint32,bytes32,bytes,bytes,address)'](
      ...dispatchParams,
      {
        ...core.multiProvider.getTransactionOverrides(origin),
        value: quote,
        gasLimit: addBufferToGasLimit(estimateGas),
        nonce,
      },
    );
    rootLogger.info(`[${origin} ${nonce}] -> ${destination}`);
    return;
  } catch (e) {
    rootLogger.error(
      `Encountered error sending message from ${origin} to ${destination}`,
    );
    throw e;
  }
}

async function getNonces(
  multiProvider: any,
  targetNetworks: string[],
): Promise<ChainMap<number>> {
  const nonces = await Promise.all(
    targetNetworks.map(async (chain) => {
      try {
        const provider = multiProvider.getProvider(chain);
        const nonce = await provider.getTransactionCount(
          await multiProvider.getSignerAddress(chain),
        );
        return { chain, nonce };
      } catch (error: any) {
        rootLogger.error(`Error fetching nonce for chain ${chain}:`, error);
        throw new Error(
          `Error fetching nonce for chain ${chain}: ${error.message}`,
        );
      }
    }),
  );

  return nonces.reduce((acc, { chain, nonce }) => {
    acc[chain] = nonce;
    return acc;
  }, {} as ChainMap<number>);
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

  for (let i = 0; i < kesselRunConfig.bursts; i++) {
    for (const origin of ['optimismsepolia', 'arbitrumsepolia']) {
      let nonce = startingNonces[origin];
      for (const [destination, percentage] of Object.entries(
        kesselRunConfig.distArbOp,
      )) {
        const txCount =
          Math.floor(kesselRunConfig.transactionsPerMinute * percentage) + 1;
        for (let j = 0; j < txCount; j++) {
          if (origin === destination) {
            continue;
          }
          await sendTestMessage({
            origin,
            destination,
            core,
            nonce,
          });
          nonce++;
        }
      }
    }

    for (const origin of ['basesepolia', 'sepolia', 'bsctestnet']) {
      let nonce = startingNonces[origin];
      for (const [destination, percentage] of Object.entries(
        kesselRunConfig.distBaseBscEth,
      )) {
        const txCount =
          Math.floor(kesselRunConfig.transactionsPerMinute * percentage) + 1;
        for (let j = 0; j < txCount; j++) {
          if (origin === destination) {
            continue;
          }
          await sendTestMessage({
            origin,
            destination,
            core,
            nonce,
          });
          nonce++;
        }
      }
    }

    rootLogger.info(`Completed burst ${i + 1}`);
    if (i < kesselRunConfig.bursts - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, kesselRunConfig.burstInterval),
      );
    }
  }
}

doTheKesselRun().catch((error) => {
  rootLogger.error('Error doing the kessel run:', error);
  process.exit(1);
});
