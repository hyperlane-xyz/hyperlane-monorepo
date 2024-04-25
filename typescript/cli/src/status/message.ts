import { input } from '@inquirer/prompts';

import { ChainName, HyperlaneCore } from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function checkMessageStatus({
  context,
  messageId,
  destination,
  origin,
  selfRelay,
}: {
  context: CommandContext;
  messageId?: string;
  destination?: ChainName;
  origin?: ChainName;
  selfRelay?: boolean;
}) {
  if (!destination) {
    destination = await runSingleChainSelectionStep(
      context.chainMetadata,
      'Select the destination chain',
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
  const mailbox = core.getContracts(destination).mailbox;
  log(`Checking status of message ${messageId} on ${destination}`);
  const delivered = await mailbox.delivered(messageId);
  if (delivered) {
    logGreen(`Message ${messageId} was delivered`);
    return;
  }
  logBlue(`Message ${messageId} was not yet delivered`);

  if (selfRelay) {
    // TODO: implement option for tx receipt input
    if (!origin) {
      origin = await runSingleChainSelectionStep(
        context.chainMetadata,
        'Select the origin chain',
      );
    }

    const receipt = await core.getDispatchTx(origin, messageId);
    const messages = core.getDispatchedMessages(receipt);
    await core.relayMessage(messages[0]);
    logGreen(`Message ${messageId} was self-relayed!`);
  }
}
