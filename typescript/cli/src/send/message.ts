import { ethers } from 'ethers';

import { ChainName, HyperlaneCore, HyperlaneRelayer } from '@hyperlane-xyz/sdk';
import { addressToBytes32, timeout } from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { CommandContext, WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function sendTestMessage({
  context,
  origin,
  destination,
  messageBody,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  origin?: ChainName;
  destination?: ChainName;
  messageBody: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { chainMetadata } = context;

  if (!origin) {
    origin = await runSingleChainSelectionStep(
      chainMetadata,
      'Select the origin chain',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      chainMetadata,
      'Select the destination chain',
    );
  }

  await runPreflightChecksForChains({
    context,
    chains: [origin, destination],
    chainsToGasCheck: [origin],
    minGas: MINIMUM_TEST_SEND_GAS,
  });

  await timeout(
    executeDelivery({
      context,
      origin,
      destination,
      messageBody,
      skipWaitForDelivery,
      selfRelay,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  context,
  origin,
  destination,
  messageBody,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: CommandContext;
  origin: ChainName;
  destination: ChainName;
  messageBody: string;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { registry, multiProvider } = context;
  const chainAddresses = await registry.getAddresses();
  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
  const mailbox = core.getContracts(origin).mailbox;

  let hook = chainAddresses[origin]?.customHook;
  if (hook) {
    logBlue(`Using custom hook ${hook} for ${origin} -> ${destination}`);
  } else {
    hook = await mailbox.defaultHook();
    logBlue(`Using default hook ${hook} for ${origin} -> ${destination}`);
  }

  const destinationDomain = multiProvider.getDomainId(destination);
  let txReceipt: ethers.ContractReceipt;
  try {
    const recipient = chainAddresses[destination].testRecipient;
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

    if (selfRelay) {
      const relayer = new HyperlaneRelayer(core);
      log('Attempting self-relay of message');
      await relayer.relayMessage(txReceipt);
      logGreen('Message was self-relayed!');
      return;
    }
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
