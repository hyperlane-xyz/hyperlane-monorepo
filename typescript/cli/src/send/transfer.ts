import {
  ChainName,
  HyperlaneCore,
  MultiProtocolProvider,
  ProviderType,
  Token,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { timeout } from '@hyperlane-xyz/utils';

import { readWarpRouteConfig } from '../config/warp.js';
import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export async function sendTestTransfer({
  context,
  warpConfigPath,
  origin,
  destination,
  wei,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  warpConfigPath: string;
  origin?: ChainName;
  destination?: ChainName;
  wei: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { chainMetadata } = context;

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
    context,
    origin,
    remotes: [destination],
    minGas: MINIMUM_TEST_SEND_GAS,
    chainsToGasCheck: [origin],
  });

  await timeout(
    executeDelivery({
      context,
      origin,
      destination,
      warpCoreConfig,
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
  wei,
  recipient,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
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

  let token: Token;
  const tokensForRoute = warpCore.getTokensForRoute(origin, destination);
  if (tokensForRoute.length === 0) {
    logRed(`No Warp Routes found from ${origin} to ${destination}`);
    throw new Error('Error finding warp route');
  } else if (tokensForRoute.length === 1) {
    token = tokensForRoute[0];
  } else {
    logBlue(`Please select a token from the Warp config`);
    const routerAddress = await runTokenSelectionStep(tokensForRoute);
    token = warpCore.findToken(origin, routerAddress)!;
  }

  const senderAddress = await signer.getAddress();
  const errors = await warpCore.validateTransfer({
    originTokenAmount: token.amount(wei),
    destination,
    recipient: recipient ?? senderAddress,
    sender: senderAddress,
  });
  if (errors) {
    logRed('Error validating transfer', JSON.stringify(errors));
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
