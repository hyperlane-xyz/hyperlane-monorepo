import { Account, Provider } from 'starknet';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainName,
  HyperlaneCore,
  HyperlaneRelayer,
  StarknetCore,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, timeout } from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { CommandContext, WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { indentYamlOrJson } from '../utils/files.js';
import { stubMerkleTreeConfig } from '../utils/relay.js';

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
  const provider = new Provider({
    nodeUrl: 'http://127.0.0.1:5050',
  });
  const account = new Account(
    provider,
    '0x6acf82752859a6bced2eb2e9e4346062763088e72422d6f7c2ee8a7526e07d7',
    '0x000000000000000000000000000000004e4993ca00259617c8075a3f76d43abc',
  );
  try {
    const recipient =
      chainAddresses[destination].testRecipient ||
      '0x00581bb8ad9e4ecd0ba06793e2ffb26f4b12ea18ec69dfb216738efe569e2e59';
    if (!recipient) {
      throw new Error(`Unable to find TestRecipient for ${destination}`);
    }
    const formattedRecipient = addressToBytes32(recipient);

    // log('Dispatching message');
    const destinationDomain = multiProvider.getDomainId(destination);

    const starknet = new StarknetCore(account);
    const tx = await starknet.sendMessage({
      destinationDomain,
      messageBody,
      recipientAddress: chainAddresses[destination].testRecipient,
    });
    console.log({ tx });
    return;
    const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

    const { dispatchTx, message } = await core.sendMessage(
      origin,
      destination,
      formattedRecipient,
      messageBody,
      // override the the default hook (with IGP) for self-relay to avoid race condition with the production relayer
      selfRelay ? chainAddresses[origin].merkleTreeHook : undefined,
    );
    logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    logBlue(`Message ID: ${message.id}`);
    log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);

    if (selfRelay) {
      const relayer = new HyperlaneRelayer({ core });

      const hookAddress = await core.getSenderHookAddress(message);
      const merkleAddress = chainAddresses[origin].merkleTreeHook;
      stubMerkleTreeConfig(relayer, origin, hookAddress, merkleAddress);

      log('Attempting self-relay of message');
      await relayer.relayMessage(dispatchTx);
      logGreen('Message was self-relayed!');
    } else {
      if (skipWaitForDelivery) {
        return;
      }

      log('Waiting for message delivery on destination chain...');
      // Max wait 10 minutes
      return;
      await core.waitForMessageProcessed(dispatchTx, 10000, 60);
      logGreen('Message was delivered!');
    }
  } catch (e) {
    errorRed(
      `Encountered error sending message from ${origin} to ${destination}`,
    );
    throw e;
  }
}
