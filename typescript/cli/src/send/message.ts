import { stringify as yamlStringify } from 'yaml';

import {
  ChainName,
  HyperlaneCore,
  HyperlaneRelayer,
  StarknetCore,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  addressToBytes32,
  assert,
  timeout,
} from '@hyperlane-xyz/utils';

import { EXPLORER_URL, MINIMUM_TEST_SEND_GAS } from '../consts.js';
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
      'Select the origin chain:',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      chainMetadata,
      'Select the destination chain:',
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
  const { registry, multiProvider, multiProtocolSigner } = context;
  const chainAddresses = await registry.getAddresses();
  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
  const destinationDomain = multiProvider.getDomainId(destination);
  const originProtocol = multiProvider.getProtocol(origin);

  if (originProtocol === ProtocolType.Starknet) {
    assert(multiProtocolSigner, 'MultiProtocolSignerManager is required');

    const starknetSigner = await multiProtocolSigner.getStarknetSigner(origin);
    assert(starknetSigner, `Signer for ${origin} chain is required`);

    const starknet = new StarknetCore(
      starknetSigner,
      chainAddresses,
      multiProvider,
    );
    const { messages } = await starknet.sendMessage({
      origin,
      destinationDomain,
      messageBody,
      recipientAddress: chainAddresses[destination].testRecipient,
    });

    console.log({ messages });
    if (messages.length > 0) {
      const message = messages[0];
      logBlue(
        `Sent message from ${origin} to ${chainAddresses[destination].testRecipient} on ${destination}.`,
      );
      logBlue(`Message ID: ${message.id}`);
      log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
    }

    return;
  }

  try {
    const recipient = chainAddresses[destination].testRecipient;
    if (!recipient) {
      throw new Error(`Unable to find TestRecipient for ${destination}`);
    }
    const formattedRecipient = addressToBytes32(recipient);

    log('Dispatching message');
    const { dispatchTx, message } = await core.sendMessage(
      origin,
      destination,
      formattedRecipient,
      messageBody,
      // override the default hook (with IGP) for self-relay to avoid race condition with the production relayer
      selfRelay ? chainAddresses[origin].merkleTreeHook : undefined,
    );
    logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    logBlue(`Message ID: ${message.id}`);
    logBlue(`Explorer Link: ${EXPLORER_URL}/message/${message.id}`);
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
