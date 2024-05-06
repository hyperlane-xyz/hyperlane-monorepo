import type { TransactionReceipt } from '@ethersproject/providers';
import { input } from '@inquirer/prompts';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneCore,
  HyperlaneRelayer,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { log, logBlue, logGreen } from '../logger.js';
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

  let message: DispatchedMessage;
  let dispatchedTx: TransactionReceipt;
  try {
    const dispatched = await core.getDispatched(origin, messageId);
    message = dispatched.message;
    dispatchedTx = dispatched.tx;
  } catch (e) {
    if (!dispatchTx) {
      dispatchTx = await input({
        message: 'Failed to infer dispatch tx, provide transaction hash',
      });
    }
    dispatchedTx = await core.multiProvider
      .getProvider(origin)
      .getTransactionReceipt(dispatchTx);
    message = core.getDispatchedMessages(dispatchedTx)[0];
  }

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

    const relayer = new HyperlaneRelayer(core);
    deliveredTx = await relayer.relayMessage(dispatchedTx);
  }

  logGreen(
    `Message ${messageId} delivered in ${context.multiProvider.getExplorerTxUrl(
      message.parsed.destination,
      { hash: deliveredTx.transactionHash },
    )}`,
  );
}
