import { HyperlaneCore, StarknetCore } from '@hyperlane-xyz/sdk';
import { ChainName, MessageService } from '@hyperlane-xyz/sdk';
import { ProtocolType, timeout } from '@hyperlane-xyz/utils';

import { EXPLORER_URL, MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { CommandContext, WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen } from '../logger.js';
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
  const { chainMetadata, multiProvider } = context;

  // Chain selection if not provided
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

  // Preflight checks
  await runPreflightChecksForChains({
    context,
    chains: [origin, destination],
    chainsToGasCheck: [origin],
    minGas: MINIMUM_TEST_SEND_GAS,
  });

  const addressMap = await context.registry.getAddresses();

  // Create protocol-specific cores map
  const protocolCores: Partial<
    Record<ProtocolType, HyperlaneCore | StarknetCore>
  > = {};

  // Initialize cores for the chains we're working with
  for (const chain of [origin, destination]) {
    const protocol = chainMetadata[chain].protocol;

    // Only initialize each protocol type once
    if (!protocolCores[protocol]) {
      if (protocol === ProtocolType.Starknet) {
        protocolCores[protocol] = new StarknetCore(
          addressMap,
          multiProvider,
          context.multiProtocolSigner!,
        );
      } else {
        // For all other protocols, use HyperlaneCore
        protocolCores[protocol] = HyperlaneCore.fromAddressesMap(
          addressMap,
          multiProvider,
        );
      }
    }
  }

  const messageService = new MessageService(multiProvider, protocolCores);

  await timeout(
    Promise.resolve().then(async () => {
      logBlue(`Sending message from ${origin} to ${destination}`);

      const { message } = await messageService.sendMessage({
        origin: origin!,
        destination: destination!,
        recipient: addressMap[destination!].testRecipient,
        body: messageBody,
      });

      log(`Message dispatched with ID: ${message.id}`);

      if (selfRelay) {
        log('Attempting self-relay of message');
        await messageService.relayMessage(message);
        logGreen('Message was self-relayed!');
      } else if (!skipWaitForDelivery) {
        log('Waiting for message delivery...');
      }
    }),
    timeoutSec * 1000,
    'Timed out waiting for message to be delivered',
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
