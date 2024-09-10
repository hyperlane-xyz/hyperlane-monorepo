import { stringify as yamlStringify } from 'yaml';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneCore,
  HyperlaneRelayer,
  MultiProtocolProvider,
  ProviderType,
  Token,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { timeout } from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { indentYamlOrJson } from '../utils/files.js';
import { stubMerkleTreeConfig } from '../utils/relay.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export async function sendTestTransfer({
  context,
  warpCoreConfig,
  origin,
  destination,
  amount,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  warpCoreConfig: WarpCoreConfig;
  origin?: ChainName;
  destination?: ChainName;
  amount: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { chainMetadata } = context;

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

  // TODO: this should be skipped for non-evm chains
  // await runPreflightChecksForChains({
  //   context,
  //   chains: [origin, destination],
  //   chainsToGasCheck: [origin],
  //   minGas: MINIMUM_TEST_SEND_GAS,
  // });

  await timeout(
    executeDelivery({
      context,
      origin,
      destination,
      warpCoreConfig,
      amount,
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
  amount,
  recipient,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
  amount: string;
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
    originTokenAmount: token.amount(amount),
    destination,
    recipient: recipient ?? senderAddress,
    sender: senderAddress,
  });
  if (errors) {
    logRed('Error validating transfer', JSON.stringify(errors));
    throw new Error('Error validating transfer');
  }

  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
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
  const messageIndex: number = 0;
  const message: DispatchedMessage =
    HyperlaneCore.getDispatchedMessages(transferTxReceipt)[messageIndex];

  logBlue(
    `Sent transfer from sender (${senderAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);

  if (selfRelay) {
    const relayer = new HyperlaneRelayer({ core });

    const hookAddress = await core.getSenderHookAddress(message);
    const merkleAddress = chainAddresses[origin].merkleTreeHook;
    stubMerkleTreeConfig(relayer, origin, hookAddress, merkleAddress);

    log('Attempting self-relay of transfer...');
    await relayer.relayMessage(transferTxReceipt, messageIndex, message);
    logGreen('Transfer was self-relayed!');
    return;
  }

  if (skipWaitForDelivery) return;

  // Max wait 10 minutes
  await core.waitForMessageProcessed(transferTxReceipt, 10000, 60);
  logGreen(`Transfer sent to destination chain!`);
}
