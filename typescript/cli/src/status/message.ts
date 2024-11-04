import type { TransactionReceipt } from '@ethersproject/providers';
import { input } from '@inquirer/prompts';

import { ChainName, HyperlaneCore, HyperlaneRelayer } from '@hyperlane-xyz/sdk';

import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function checkMessageStatus({
  context,
  messageId,
  destination,
  origin,
  selfRelay,
  dispatchTx,
}: {
  context: WriteCommandContext;
  dispatchTx?: string;
  messageId?: string;
  destination?: ChainName;
  origin?: ChainName;
  selfRelay?: boolean;
}) {
  if (!origin) {
    origin = await runSingleChainSelectionStep(
      context.chainMetadata,
      'Select the origin chain',
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
    } catch (e) {
      logRed(`Failed to infer dispatch transaction for message ${messageId}`);

      dispatchTx = await input({
        message: 'Provide dispatch transaction hash',
      });
      dispatchedReceipt = await context.multiProvider
        .getProvider(origin)
        .getTransactionReceipt(dispatchTx);
    }
  }

  const messages = core.getDispatchedMessages(dispatchedReceipt);

  let undelivered = [];
  for (const message of messages) {
    log(
      `Checking status of message ${message.id} on ${message.parsed.destinationChain}`,
    );
    const delivered = await core.isDelivered(message);
    if (delivered) {
      logGreen(`Message ${message.id} was delivered`);
    } else {
      logBlue(`Message ${message.id} was not yet delivered`);
      undelivered.push(message);
    }
  }

  if (selfRelay) {
    const relayer = new HyperlaneRelayer({ core });
    await relayer.relayAll(dispatchedReceipt, undelivered);
  }
}
