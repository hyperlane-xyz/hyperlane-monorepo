import { ethers } from 'ethers';

import {
  ChainName,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, timeout } from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { getContext, getMergedContractAddresses } from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function sendTestMessage({
  key,
  chainConfigPath,
  coreArtifactsPath,
  origin,
  destination,
  messageBody,
  timeoutSec,
  skipWaitForDelivery,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath?: string;
  origin?: ChainName;
  destination?: ChainName;
  messageBody: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
}) {
  const { signer, multiProvider, customChains, coreArtifacts } =
    await getContext({
      chainConfigPath,
      coreConfig: { coreArtifactsPath },
      keyConfig: { key },
    });

  if (!origin) {
    origin = await runSingleChainSelectionStep(
      customChains,
      'Select the origin chain',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      customChains,
      'Select the destination chain',
    );
  }

  await runPreflightChecks({
    origin,
    remotes: [destination],
    multiProvider,
    signer,
    minGas: MINIMUM_TEST_SEND_GAS,
    chainsToGasCheck: [origin],
  });

  await timeout(
    executeDelivery({
      origin,
      destination,
      messageBody,
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
  messageBody,
  multiProvider,
  coreArtifacts,
  skipWaitForDelivery,
}: {
  origin: ChainName;
  destination: ChainName;
  messageBody: string;
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

  let hook = mergedContractAddrs[origin]?.customHook;
  if (hook) {
    logBlue(`Using custom hook ${hook} for ${origin} -> ${destination}`);
  } else {
    hook = await mailbox.defaultHook();
    logBlue(`Using default hook ${hook} for ${origin} -> ${destination}`);
  }

  const destinationDomain = multiProvider.getDomainId(destination);
  let txReceipt: ethers.ContractReceipt;
  try {
    const recipient = mergedContractAddrs[destination].testRecipient;
    if (!recipient) {
      throw new Error(`Unable to find TestRecipient for ${destination}`);
    }
    const formattedRecipient = addressToBytes32(recipient);

    log('Getting gas quote');
    const value = await mailbox[
      'quoteDispatch(uint32,bytes32,bytes,bytes,address)'
    ](
      destinationDomain,
      formattedRecipient,
      messageBody,
      ethers.utils.hexlify([]),
      hook,
    );
    log(`Paying for gas with ${value} wei`);

    log('Dispatching message');
    const messageTx = await mailbox[
      'dispatch(uint32,bytes32,bytes,bytes,address)'
    ](
      destinationDomain,
      formattedRecipient,
      messageBody,
      ethers.utils.hexlify([]),
      hook,
      {
        value,
      },
    );
    txReceipt = await multiProvider.handleTx(origin, messageTx);
    const message = core.getDispatchedMessages(txReceipt)[0];
    logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    logBlue(`Message ID: ${message.id}`);
    log(`Message: ${JSON.stringify(message)}`);
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
