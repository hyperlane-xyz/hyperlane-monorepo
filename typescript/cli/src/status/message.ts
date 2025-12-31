import type { TransactionReceipt } from '@ethersproject/providers';
import { input } from '@inquirer/prompts';

import {
  type ChainName,
  type DispatchedMessage,
  HyperlaneCore,
  HyperlaneRelayer,
} from '@hyperlane-xyz/sdk';

import {
  type CommandContext,
  type WriteCommandContext,
} from '../context/types.js';
import { log, logBlue, logGreen, logRed, warnYellow } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { stubMerkleTreeConfig } from '../utils/relay.js';

export async function checkMessageStatus({
  context,
  messageId,
  origin,
  selfRelay,
  dispatchTx,
}: {
  context: CommandContext | WriteCommandContext;
  dispatchTx?: string;
  messageId?: string;
  origin?: ChainName;
  selfRelay?: boolean;
}) {
  if (!origin) {
    origin = await runSingleChainSelectionStep(
      context.chainMetadata,
      'Select the origin chain:',
    );
  }

  const coreAddresses = await context.registry.getAddresses();
  const core = HyperlaneCore.fromAddressesMap(
    coreAddresses,
    context.multiProvider,
  );

  let dispatchedReceipt: TransactionReceipt;

  if (dispatchTx) {
    dispatchedReceipt = await context.multiProvider
      .getProvider(origin)
      .getTransactionReceipt(dispatchTx);
  } else {
    messageId ??= await input({
      message: 'Please specify the message id',
    });
    try {
      dispatchedReceipt = await core.getDispatchTx(origin, messageId);
    } catch {
      logRed(`Failed to infer dispatch transaction for message ${messageId}`);

      dispatchTx = await input({
        message: 'Provide dispatch transaction hash',
      });
      dispatchedReceipt = await context.multiProvider
        .getProvider(origin)
        .getTransactionReceipt(dispatchTx);
    }
  }

  const dispatched = core.getDispatchedMessages(dispatchedReceipt);

  const messages = messageId
    ? dispatched.filter((m) => m.id === messageId)
    : dispatched;

  const undelivered = [];
  for (const message of messages) {
    log(
      `Checking status of message ${message.id} on ${message.parsed.destinationChain}`,
    );
    let delivered;
    try {
      delivered = await core.isDelivered(message);
    } catch (error) {
      logRed(
        `Failed to check if message ${message.id} was delivered: ${error}`,
      );
      undelivered.push(message);
      continue;
    }
    if (delivered) {
      try {
        const processedReceipt = await core.getProcessedReceipt(message);
        const hash = processedReceipt.transactionHash;
        const url = context.multiProvider.tryGetExplorerTxUrl(
          message.parsed.destination,
          { hash },
        );
        logGreen(`Message ${message.id} was delivered in ${url || hash}`);
      } catch (error) {
        logRed(`Failed to fetch processed receipt: ${error}`);
        logGreen(`Message ${message.id} was delivered`);
      }
    } else {
      logBlue(`Message ${message.id} was not yet delivered`);
      undelivered.push(message);
    }
  }

  if (selfRelay && undelivered.length > 0) {
    // Filter messages to only those we can relay (have signer for destination)
    const { relayable, skipped } = filterRelayableMessages(
      undelivered,
      context.multiProvider,
    );

    if (skipped.length > 0) {
      for (const msg of skipped) {
        warnYellow(
          `Skipping relay of message ${msg.id} to ${msg.parsed.destinationChain} - no signer available for destination chain`,
        );
      }
    }

    if (relayable.length > 0) {
      const relayer = new HyperlaneRelayer({ core });
      for (const message of relayable) {
        const hookAddress = await core.getSenderHookAddress(message);
        const merkleAddress = coreAddresses[origin].merkleTreeHook;
        stubMerkleTreeConfig(relayer, origin, hookAddress, merkleAddress);
      }
      await relayer.relayAll(dispatchedReceipt, relayable);
    } else if (undelivered.length > 0) {
      warnYellow(
        'No messages could be relayed - missing signers for all destination chains',
      );
    }
  }
}

/**
 * Filters messages into relayable (have signer) and skipped (no signer) groups
 * @internal Exported for testing
 */
export function filterRelayableMessages(
  messages: DispatchedMessage[],
  multiProvider: CommandContext['multiProvider'],
): { relayable: DispatchedMessage[]; skipped: DispatchedMessage[] } {
  const relayable: DispatchedMessage[] = [];
  const skipped: DispatchedMessage[] = [];

  for (const message of messages) {
    const destinationChain = message.parsed.destinationChain;
    if (!destinationChain) {
      skipped.push(message);
      continue;
    }

    try {
      // Check if we have a signer for this chain
      const signer = multiProvider.tryGetSigner(destinationChain);
      if (signer) {
        relayable.push(message);
      } else {
        skipped.push(message);
      }
    } catch {
      // Chain not known or signer not available
      skipped.push(message);
    }
  }

  return { relayable, skipped };
}
