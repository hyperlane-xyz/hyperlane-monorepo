import { BigNumber, ethers } from 'ethers';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneContractsMap,
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, sleep, timeout } from '@hyperlane-xyz/utils';

import { readDeploymentArtifacts } from '../configs.js';
import { MINIMUM_TEST_SEND_BALANCE } from '../consts.js';
import { getDeployerContext, getMergedContractAddresses } from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';

const GAS_AMOUNT = 300_000;

// TODO improve the UX here by making params optional and
// prompting for missing values
export async function sendTestMessage({
  key,
  chainConfigPath,
  coreArtifactsPath,
  origin,
  destination,
  timeoutSec,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath: string;
  origin: ChainName;
  destination: ChainName;
  timeoutSec: number;
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
    minBalanceWei: MINIMUM_TEST_SEND_BALANCE,
  });

  await timeout(
    executeDelivery({ origin, destination, multiProvider, signer, artifacts }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  origin,
  destination,
  multiProvider,
  signer,
  artifacts,
}: {
  origin: ChainName;
  destination: ChainName;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  artifacts?: HyperlaneContractsMap<any>;
}) {
  const mergedContractAddrs = getMergedContractAddresses(artifacts);
  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );
  const mailbox = core.getContracts(origin).mailbox;
  const igp = HyperlaneIgp.fromAddressesMap(mergedContractAddrs, multiProvider);
  const igpContract = igp.getContracts(origin).defaultIsmInterchainGasPaymaster;

  const destinationDomain = multiProvider.getDomainId(destination);
  const signerAddress = await signer.getAddress();

  let message: DispatchedMessage;
  try {
    const recipient = mergedContractAddrs[destination].testRecipient;
    if (!recipient) {
      throw new Error(`Unable to find TestRecipient for ${destination}`);
    }

    log('Dispatching message');
    const messageTx = await mailbox.dispatch(
      destinationDomain,
      addressToBytes32(recipient),
      '0x48656c6c6f21', // Hello!
    );
    const messageReceipt = await multiProvider.handleTx(origin, messageTx);
    message = core.getDispatchedMessages(messageReceipt)[0];
    logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    logBlue(`Message ID: ${message.id}`);

    const value = await igp.quoteGasPaymentForDefaultIsmIgp(
      origin,
      destination,
      BigNumber.from(GAS_AMOUNT),
    );
    log(`Paying for gas with ${value} wei`);
    const paymentTx = await igpContract.payForGas(
      message.id,
      destinationDomain,
      GAS_AMOUNT,
      signerAddress,
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
    await sleep(5000);
  }

  logGreen('Message was delivered!');
}
