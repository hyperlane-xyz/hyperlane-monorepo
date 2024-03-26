import { select } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ChainName,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProtocolProvider,
  MultiProvider,
  ProviderType,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { Address, timeout } from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { getContext, getMergedContractAddresses } from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function sendTestTransfer({
  key,
  chainConfigPath,
  coreArtifactsPath,
  warpConfigPath,
  origin,
  destination,
  routerAddress,
  wei,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath?: string;
  warpConfigPath: string;
  origin?: ChainName;
  destination?: ChainName;
  routerAddress?: Address;
  wei: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
}) {
  const { signer, multiProvider, customChains, coreArtifacts, warpCoreConfig } =
    await getContext({
      chainConfigPath,
      coreConfig: { coreArtifactsPath },
      keyConfig: { key },
      warpConfig: { warpConfigPath },
    });

  if (!origin) {
    origin = await runSingleChainSelectionStep(
      customChains,
      'Select the origin chain',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      customChains,
      'Select the destination chain',
    );
  }

  await runPreflightChecks({
    origin,
    remotes: [destination],
    multiProvider,
    signer,
    minGas: MINIMUM_TEST_SEND_GAS,
    chainsToGasCheck: [origin],
  });

  await timeout(
    executeDelivery({
      origin,
      destination,
      warpCoreConfig,
      routerAddress,
      wei,
      recipient,
      signer,
      multiProvider,
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
  warpCoreConfig,
  routerAddress,
  wei,
  recipient,
  multiProvider,
  signer,
  coreArtifacts,
  skipWaitForDelivery,
}: {
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
  routerAddress?: Address;
  wei: string;
  recipient?: string;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  coreArtifacts?: HyperlaneContractsMap<any>;
  skipWaitForDelivery: boolean;
}) {
  const signerAddress = await signer.getAddress();
  recipient ||= signerAddress;

  const mergedContractAddrs = getMergedContractAddresses(coreArtifacts);

  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );

  const provider = multiProvider.getProvider(origin);
  const connectedSigner = signer.connect(provider);

  const warpCore = WarpCore.FromConfig(
    MultiProtocolProvider.fromMultiProvider(multiProvider),
    warpCoreConfig,
  );

  if (!routerAddress) {
    const tokensForRoute = warpCore.getTokensForRoute(origin, destination);
    if (tokensForRoute.length === 0) {
      logRed(`No Warp Routes found from ${origin} to ${destination}`);
      throw new Error('Error finding warp route');
    }

    routerAddress = (await select({
      message: `Select router address`,
      choices: [
        ...tokensForRoute.map((t) => ({
          value: t.addressOrDenom,
          description: `${t.name} ($${t.symbol})`,
        })),
      ],
      pageSize: 10,
    })) as string;
  }

  const token = warpCore.findToken(origin, routerAddress);
  if (!token) {
    logRed(
      `No Warp Routes found from ${origin} to ${destination} with router address ${routerAddress}`,
    );
    throw new Error('Error finding warp route');
  }

  const senderAddress = await signer.getAddress();
  const errors = await warpCore.validateTransfer({
    originTokenAmount: token.amount(wei),
    destination,
    recipient: recipient ?? senderAddress,
    sender: senderAddress,
  });
  if (errors) {
    logRed('Unable to validate transfer', errors);
    throw new Error('Error validating transfer');
  }

  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(wei, token),
    destination,
    sender: senderAddress,
    recipient: recipient ?? senderAddress,
  });

  const txReceipts = [];
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5) {
      const txResponse = await connectedSigner.sendTransaction(tx.transaction);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      txReceipts.push(txReceipt);
    }
  }

  const transferTxReceipt = txReceipts[txReceipts.length - 1];

  const message = core.getDispatchedMessages(transferTxReceipt)[0];
  logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
  logBlue(`Message ID: ${message.id}`);

  if (skipWaitForDelivery) return;

  // Max wait 10 minutes
  await core.waitForMessageProcessed(transferTxReceipt, 10000, 60);
  logGreen(`Transfer sent to destination chain!`);
}
