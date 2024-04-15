import { input } from '@inquirer/prompts';

import { ChainName, HyperlaneCore } from '@hyperlane-xyz/sdk';

import { getContext, getMergedContractAddresses } from '../context.js';
import { log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function checkMessageStatus({
  chainConfigPath,
  coreArtifactsPath,
  messageId,
  destination,
  origin,
  selfRelay,
  key,
}: {
  chainConfigPath: string;
  coreArtifactsPath?: string;
  messageId?: string;
  destination?: ChainName;
  origin?: ChainName;
  selfRelay?: boolean;
  key?: string;
}) {
  const keyConfig = selfRelay ? { key } : undefined;

  const { multiProvider, customChains, coreArtifacts } = await getContext({
    chainConfigPath,
    coreConfig: { coreArtifactsPath },
    keyConfig,
  });

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      customChains,
      'Select the destination chain',
    );
  }

  if (!messageId) {
    messageId = await input({
      message: 'Please specify the message id',
    });
  }

  const mergedContractAddrs = getMergedContractAddresses(coreArtifacts);
  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
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
        customChains,
        'Select the origin chain',
      );
    }

    const receipt = await core.getDispatchTx(origin, messageId);
    const messages = core.getDispatchedMessages(receipt);
    await core.relayMessage(messages[0]);
    logGreen(`Message ${messageId} was self-relayed!`);
  }
}
