import { ethers } from 'ethers';

import {
  ChainName,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, timeout } from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen } from '../../logger.js';
import { readDeploymentArtifacts } from '../config/artifacts.js';
import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import {
  getContextWithSigner,
  getMergedContractAddresses,
} from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';

const MESSAGE_BODY = '0x48656c6c6f21'; // Hello!'

// TODO improve the UX here by making params optional and
// prompting for missing values
export async function sendTestMessage({
  key,
  chainConfigPath,
  coreArtifactsPath,
  origin,
  destination,
  timeoutSec,
  skipWaitForDelivery,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath: string;
  origin: ChainName;
  destination: ChainName;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
}) {
  const { signer, multiProvider } = getContextWithSigner(key, chainConfigPath);
  const coreArtifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

  await runPreflightChecks({
    origin,
    remotes: [destination],
    multiProvider,
    signer,
    minGas: MINIMUM_TEST_SEND_GAS,
  });

  await timeout(
    executeDelivery({
      origin,
      destination,
      multiProvider,
      coreArtifacts,
      skipWaitForDelivery,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  origin,
  destination,
  multiProvider,
  coreArtifacts,
  skipWaitForDelivery,
}: {
  origin: ChainName;
  destination: ChainName;
  multiProvider: MultiProvider;
  coreArtifacts?: HyperlaneContractsMap<any>;
  skipWaitForDelivery: boolean;
}) {
  const mergedContractAddrs = getMergedContractAddresses(coreArtifacts);
  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );
  const mailbox = core.getContracts(origin).mailbox;

  const destinationDomain = multiProvider.getDomainId(destination);
  let txReceipt: ethers.ContractReceipt;
  try {
    const recipient = mergedContractAddrs[destination].testRecipient;
    if (!recipient) {
      throw new Error(`Unable to find TestRecipient for ${destination}`);
    }
    const formattedRecipient = addressToBytes32(recipient);

    log('Getting gas quote');
    const value = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
      destinationDomain,
      formattedRecipient,
      MESSAGE_BODY,
    );
    log(`Paying for gas with ${value} wei`);

    log('Dispatching message');
    const messageTx = await mailbox['dispatch(uint32,bytes32,bytes)'](
      destinationDomain,
      formattedRecipient,
      MESSAGE_BODY,
      { value },
    );
    txReceipt = await multiProvider.handleTx(origin, messageTx);
    const message = core.getDispatchedMessages(txReceipt)[0];
    logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    logBlue(`Message ID: ${message.id}`);
  } catch (e) {
    errorRed(
      `Encountered error sending message from ${origin} to ${destination}`,
    );
    throw e;
  }

  if (skipWaitForDelivery) return;

  log('Waiting for message delivery on destination chain...');
  // Max wait 10 minutes
  await core.waitForMessageProcessed(txReceipt, 10000, 60);
  logGreen('Message was delivered!');
}
