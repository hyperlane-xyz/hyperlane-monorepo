import { select } from '@inquirer/prompts';

import {
  ChainName,
  HyperlaneCore,
  MultiProtocolProvider,
  ProviderType,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { Address, timeout } from '@hyperlane-xyz/utils';

import { readWarpRouteConfig } from '../config/warp.js';
import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { CommandContext } from '../context/types.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function sendTestTransfer({
  context,
  warpConfigPath,
  origin,
  destination,
  routerAddress,
  wei,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: CommandContext;
  warpConfigPath: string;
  origin?: ChainName;
  destination?: ChainName;
  routerAddress?: Address;
  wei: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { signer, multiProvider, chainMetadata } = context;

  const warpCoreConfig = readWarpRouteConfig(warpConfigPath);

  if (!origin) {
    origin = await runSingleChainSelectionStep(
      chainMetadata,
      'Select the origin chain',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      chainMetadata,
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
      context,
      origin,
      destination,
      warpCoreConfig,
      routerAddress,
      wei,
      recipient,
      skipWaitForDelivery,
      selfRelay,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  context,
  origin,
  destination,
  warpCoreConfig,
  routerAddress,
  wei,
  recipient,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: CommandContext;
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
  routerAddress?: Address;
  wei: string;
  recipient?: string;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { signer, multiProvider, registry } = context;

  const signerAddress = await signer.getAddress();
  recipient ||= signerAddress;

  const chainAddresses = await registry.getAddresses();

  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

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

  if (selfRelay) {
    await core.relayMessage(message);
    logGreen('Message was self-relayed!');
    return;
  }

  if (skipWaitForDelivery) return;

  // Max wait 10 minutes
  await core.waitForMessageProcessed(transferTxReceipt, 10000, 60);
  logGreen(`Transfer sent to destination chain!`);
}
