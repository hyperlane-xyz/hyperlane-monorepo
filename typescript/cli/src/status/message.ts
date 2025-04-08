import type { TransactionReceipt } from '@ethersproject/providers';
import { input } from '@inquirer/prompts';

import { ChainName, HyperlaneCore, HyperlaneRelayer } from '@hyperlane-xyz/sdk';

import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { stubMerkleTreeConfig } from '../utils/relay.js';

export async function checkMessageStatus({
  context,
  messageId,
  origin,
  selfRelay,
  dispatchTx,
}: {
  context: WriteCommandContext;
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
    const delivered = await core.isDelivered(message);
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
    const relayer = new HyperlaneRelayer({ core });
    for (const message of undelivered) {
      const hookAddress = await core.getSenderHookAddress(message);
      const merkleAddress = coreAddresses[origin].merkleTreeHook;
      stubMerkleTreeConfig(relayer, origin, hookAddress, merkleAddress);
    }
    await relayer.relayAll(dispatchedReceipt, undelivered);
  }
}
