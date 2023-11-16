import { ChainName, HyperlaneCore } from '@hyperlane-xyz/sdk';

import { log, logBlue, logGreen } from '../../logger.js';
import { readDeploymentArtifacts } from '../config/artifacts.js';
import { getContext, getMergedContractAddresses } from '../context.js';

export async function checkMessageStatus({
  chainConfigPath,
  coreArtifactsPath,
  messageId,
  destination,
}: {
  chainConfigPath: string;
  coreArtifactsPath: string;
  messageId: string;
  destination: ChainName;
}) {
  const { multiProvider } = getContext(chainConfigPath);
  const coreArtifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

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
