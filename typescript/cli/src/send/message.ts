import { BigNumber, ethers } from 'ethers';

import {
  ChainName,
  HyperlaneContractsMap,
  HyperlaneCore,
  HyperlaneIgp,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, timeout } from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen } from '../../logger.js';
import { readDeploymentArtifacts } from '../config/artifacts.js';
import { MINIMUM_TEST_SEND_BALANCE } from '../consts.js';
import {
  getContextWithSigner,
  getMergedContractAddresses,
} from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';

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
  skipWaitForDelivery,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath: string;
  origin: ChainName;
  destination: ChainName;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
}) {
  const { signer, multiProvider } = getContextWithSigner(key, chainConfigPath);
  const coreArtifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

  await runPreflightChecks({
    origin,
    remotes: [destination],
    multiProvider,
    signer,
    minBalanceWei: MINIMUM_TEST_SEND_BALANCE,
  });

  await timeout(
    executeDelivery({
      origin,
      destination,
      multiProvider,
      signer,
      coreArtifacts,
      skipWaitForDelivery,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  origin,
  destination,
  multiProvider,
  signer,
  coreArtifacts,
  skipWaitForDelivery,
}: {
  origin: ChainName;
  destination: ChainName;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  coreArtifacts?: HyperlaneContractsMap<any>;
  skipWaitForDelivery: boolean;
}) {
  const mergedContractAddrs = getMergedContractAddresses(coreArtifacts);
  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );
  const mailbox = core.getContracts(origin).mailbox;
  const igp = HyperlaneIgp.fromAddressesMap(mergedContractAddrs, multiProvider);
  const igpContract = igp.getContracts(origin).defaultIsmInterchainGasPaymaster;

  const destinationDomain = multiProvider.getDomainId(destination);
  const signerAddress = await signer.getAddress();

  let txReceipt: ethers.ContractReceipt;
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
    txReceipt = await multiProvider.handleTx(origin, messageTx);
    const message = core.getDispatchedMessages(txReceipt)[0];
    logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
    logBlue(`Message ID: ${message.id}`);

    // TODO requires update for v3
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

  if (skipWaitForDelivery) return;

  log('Waiting for message delivery on destination chain...');
  // Max wait 10 minutes
  await core.waitForMessageProcessed(txReceipt, 10000, 60);
  logGreen('Message was delivered!');
}
