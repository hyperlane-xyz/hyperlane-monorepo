import {
  ChainName,
  DispatchedMessage,
  HyperlaneContractsMap,
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { utils } from '@hyperlane-xyz/utils';

import { readDeploymentArtifacts } from '../configs.js';
import { MINIMUM_TEST_SEND_BALANCE } from '../consts.js';
import { getDeployerContext, getMergedContractAddresses } from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { errorRed, log, logGreen } from '../logger.js';

const GAS_AMOUNT = 100_000;

// TODO improve the UX here by making params optional and
// prompting for missing values
export async function sendTestMessage({
  key,
  chainConfigPath,
  coreArtifactsPath,
  origin,
  destination,
  timeout,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath: string;
  origin: ChainName;
  destination: ChainName;
  timeout: number;
}) {
  const { signer, multiProvider } = getDeployerContext(key, chainConfigPath);
  const artifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

  await runPreflightChecks({
    local: origin,
    remotes: [destination],
    multiProvider,
    signer,
    minBalance: MINIMUM_TEST_SEND_BALANCE,
  });

  await utils.timeout(
    executeDelivery({ origin, destination, multiProvider, artifacts }),
    timeout * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  origin,
  destination,
  multiProvider,
  artifacts,
}: {
  origin: ChainName;
  destination: ChainName;
  multiProvider: MultiProvider;
  artifacts?: HyperlaneContractsMap<any>;
}) {
  const mergedContractAddrs = getMergedContractAddresses(artifacts);

  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );
  const igp = HyperlaneIgp.fromAddressesMap(mergedContractAddrs, multiProvider);
  const mailbox = core.getContracts(origin).mailbox;
  const defaultIgp = igp.getContracts(origin).defaultIsmInterchainGasPaymaster;
  const destinationDomain = multiProvider.getDomainId(destination);
  let message: DispatchedMessage;
  try {
    const recipient = mergedContractAddrs[destination].testRecipient;
    if (!recipient) {
      throw new Error(`Unable to find TestRecipient for ${destination}`);
    }
    const messageTx = await mailbox.dispatch(
      destinationDomain,
      utils.addressToBytes32(recipient),
      '0xdeadbeef',
    );
    const messageReceipt = await multiProvider.handleTx(origin, messageTx);
    message = core.getDispatchedMessages(messageReceipt)[0];
    log(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    log(`Message ID: ${message.id}`);

    const value = await defaultIgp.quoteGasPayment(
      destinationDomain,
      GAS_AMOUNT,
    );
    const paymentTx = await defaultIgp.payForGas(
      message.id,
      destinationDomain,
      GAS_AMOUNT,
      await multiProvider.getSignerAddress(origin),
      { value },
    );
    await paymentTx.wait();
  } catch (e) {
    errorRed(
      `Encountered error sending message from ${origin} to ${destination}`,
    );
    throw e;
  }
  while (true) {
    const destination = multiProvider.getChainName(message.parsed.destination);
    const mailbox = core.getContracts(destination).mailbox;
    const delivered = await mailbox.delivered(message.id);
    if (delivered) break;

    log('Waiting for message delivery on destination chain...');
    await utils.sleep(5000);
  }

  logGreen('Message was delivered!');
}
