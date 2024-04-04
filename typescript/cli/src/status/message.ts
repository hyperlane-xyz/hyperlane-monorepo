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
}: {
  chainConfigPath: string;
  coreArtifactsPath?: string;
  messageId?: string;
  destination?: ChainName;
}) {
  const { multiProvider, customChains, coreArtifacts } = await getContext({
    chainConfigPath,
    coreConfig: { coreArtifactsPath },
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
  } else {
    logBlue(`Message ${messageId} was not yet delivered`);
  }
}
