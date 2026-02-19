import { stringify as yamlStringify } from 'yaml';

import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  type ChainMap,
  type ChainName,
  type DispatchedMessage,
  HyperlaneCore,
  MultiProtocolProvider,
  ProviderType,
  type Token,
  TokenAmount,
  WarpCore,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';
import {
  ProtocolType,
  parseWarpRouteMessage,
  timeout,
} from '@hyperlane-xyz/utils';

import { EXPLORER_URL } from '../consts.js';
import { type WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed, warnYellow } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import { runSelfRelay } from '../utils/relay.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export const WarpSendLogs = {
  SUCCESS: 'Transfer was self-relayed!',
};

export async function sendTestTransfer({
  context,
  warpCoreConfig,
  chains,
  amount,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
  skipValidation,
}: {
  context: WriteCommandContext;
  warpCoreConfig: WarpCoreConfig;
  chains: ChainName[];
  amount: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
  skipValidation?: boolean;
}) {
  const { multiProvider } = context;

  // Each hop's origin must be EVM (we need an EVM signer to submit).
  // Destinations can be any protocol - the Rust relayer handles delivery.
  // When using --chains, non-EVM chains must be the final destination
  // (e.g., --chains ethereum,sealevel OK; --chains sealevel,ethereum NOT OK).
  const hopOrigins = new Set<ChainName>();
  for (let i = 0; i < chains.length - 1; i++) {
    const hopOrigin = chains[i];
    hopOrigins.add(hopOrigin);
    if (multiProvider.getProtocol(hopOrigin) !== ProtocolType.Ethereum) {
      throw new Error(
        `'hyperlane warp send' requires EVM origin chains. '${hopOrigin}' is ${multiProvider.getProtocol(hopOrigin)}. ` +
          `Non-EVM chains can only be the final destination. ` +
          `When using --chains, list EVM chains first (e.g., --chains ethereum,solana).`,
      );
    }
  }
  if (hopOrigins.size === 0) {
    throw new Error('At least two chains are required to send a warp transfer');
  }

  const finalDestination = chains[chains.length - 1];
  const normalizedRecipient =
    recipient && recipient.trim().length > 0 ? recipient : undefined;

  // Validate once up front to avoid partial multi-hop sends before failing.
  if (
    !normalizedRecipient &&
    multiProvider.getProtocol(finalDestination) !== ProtocolType.Ethereum
  ) {
    throw new Error(
      `Recipient address is required when sending to non-EVM destination '${finalDestination}'`,
    );
  }

  // Include final destination in preflight if self-relaying to EVM
  const signerChains = new Set(hopOrigins);
  if (
    selfRelay &&
    multiProvider.getProtocol(finalDestination) === ProtocolType.Ethereum
  ) {
    signerChains.add(finalDestination);
  }

  await runPreflightChecksForChains({
    context,
    chains: Array.from(signerChains),
    minGas: GasAction.TEST_SEND_GAS,
  });

  for (let i = 0; i < chains.length; i++) {
    const origin = chains[i];
    const destination = chains[i + 1];

    if (destination) {
      const recipientForHop =
        i === chains.length - 2 ? normalizedRecipient : undefined;
      logBlue(`Sending a message from ${origin} to ${destination}`);
      await timeout(
        executeDelivery({
          context,
          origin,
          destination,
          warpCoreConfig,
          amount,
          recipient: recipientForHop,
          skipWaitForDelivery,
          selfRelay,
          skipValidation,
        }),
        timeoutSec * 1000,
        'Timed out waiting for messages to be delivered',
      );
    }
  }
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
  skipValidation,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
  amount: string;
  recipient?: string;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
  skipValidation?: boolean;
}) {
  const { multiProvider, registry } = context;

  const signer = multiProvider.getSigner(origin);
  const signerAddress = await signer.getAddress();

  const isEvmDestination =
    multiProvider.getProtocol(destination) === ProtocolType.Ethereum;
  const normalizedRecipient =
    recipient && recipient.trim().length > 0 ? recipient : undefined;

  // For non-EVM destinations, recipient must be provided explicitly.
  if (!normalizedRecipient && !isEvmDestination) {
    throw new Error(
      `Recipient address is required when sending to non-EVM destination '${destination}'`,
    );
  }

  const recipientAddress =
    normalizedRecipient ??
    (await multiProvider.getSigner(destination).getAddress());
  if (!normalizedRecipient && isEvmDestination) {
    logBlue(
      `No recipient specified, defaulting to destination signer: ${recipientAddress}`,
    );
  }

  const chainAddresses = await registry.getAddresses();

  // Core is needed for on-chain wait (EVM destinations)
  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

  // Extract mailbox addresses from registry for each chain
  // Required for Sealevel/non-EVM token adapters during validation
  const mailboxAddresses: ChainMap<{ mailbox?: Address }> = {};
  for (const [chainName, addresses] of Object.entries(chainAddresses)) {
    if (addresses?.mailbox) {
      mailboxAddresses[chainName] = { mailbox: addresses.mailbox };
    }
  }

  // Extend the MultiProtocolProvider with mailbox addresses
  const multiProtocolProvider =
    MultiProtocolProvider.fromMultiProvider(multiProvider).extendChainMetadata(
      mailboxAddresses,
    );

  const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);

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

  if (!skipValidation) {
    const errors = await warpCore.validateTransfer({
      originTokenAmount: token.amount(amount),
      destination,
      recipient: recipientAddress,
      sender: signerAddress,
    });
    if (errors) {
      logRed('Error validating transfer', JSON.stringify(errors));
      throw new Error('Error validating transfer');
    }
  }

  // TODO: override hook address for self-relay
  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
    destination,
    sender: signerAddress,
    recipient: recipientAddress,
  });

  const txReceipts = [];
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5) {
      const txResponse = await signer.sendTransaction(tx.transaction);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      txReceipts.push(txReceipt);
    }
  }
  const transferTxReceipt = txReceipts[txReceipts.length - 1];
  const messageIndex: number = 0;
  const message: DispatchedMessage =
    HyperlaneCore.getDispatchedMessages(transferTxReceipt)[messageIndex];

  const parsed = parseWarpRouteMessage(message.parsed.body);

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipientAddress}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
  log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);

  if (selfRelay) {
    if (!isEvmDestination) {
      warnYellow(
        `Self-relay not supported for non-EVM destination '${destination}'. Skipping relay.`,
      );
    } else {
      return runSelfRelay({
        txReceipt: transferTxReceipt,
        multiProvider: multiProvider,
        registry: registry,
        successMessage: WarpSendLogs.SUCCESS,
      });
    }
  }

  if (skipWaitForDelivery) return;

  if (isEvmDestination) {
    // Max wait 10 minutes
    await core.waitForMessageProcessed(transferTxReceipt, 10000, 60);
    logGreen(`Transfer delivered to ${destination} chain!`);
  } else {
    logBlue(
      `Skipping delivery wait for non-EVM destination '${destination}'. Track at ${EXPLORER_URL}/message/${message.id}`,
    );
  }
}
