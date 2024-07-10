import type { TransactionReceipt } from '@ethersproject/providers';
import { input } from '@inquirer/prompts';

import { ChainName, HyperlaneCore, HyperlaneRelayer } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
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
  context: CommandContext;
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

  if (!messageId) {
    messageId = await input({
      message: 'Please specify the message id',
    });
  }

  const chainAddresses = await context.registry.getAddresses();
  const core = HyperlaneCore.fromAddressesMap(
    chainAddresses,
    context.multiProvider,
  );

  let dispatchedReceipt: TransactionReceipt;
  if (!dispatchTx) {
    try {
      dispatchedReceipt = await core.getDispatchTx(origin, messageId);
    } catch (e) {
      logRed(`Failed to infer dispatch transaction for message ${messageId}`);
    }
    dispatchTx = await input({
      message: 'Provide dispatch transaction hash',
    });
  }

  dispatchedReceipt ??= await context.multiProvider
    .getProvider(origin)
    .getTransactionReceipt(dispatchTx);

  const messages = core.getDispatchedMessages(dispatchedReceipt);
  const match = messages.find((m) => m.id === messageId);
  assert(match, `Message ${messageId} not found in dispatch tx ${dispatchTx}`);
  const message = match;

  let deliveredTx: TransactionReceipt;

  log(`Checking status of message ${messageId} on ${destination}`);
  const delivered = await core.isDelivered(message);
  if (delivered) {
    logGreen(`Message ${messageId} was delivered`);
    deliveredTx = await core.getProcessedReceipt(message);
  } else {
    logBlue(`Message ${messageId} was not yet delivered`);

    if (!selfRelay) {
      return;
    }

    const relayer = new HyperlaneRelayer({ core });
    deliveredTx = await relayer.relayMessage(dispatchedReceipt);
  }

  logGreen(
    `Message ${messageId} delivered in ${context.multiProvider.getExplorerTxUrl(
      message.parsed.destination,
      { hash: deliveredTx.transactionHash },
    )}`,
  );
}
