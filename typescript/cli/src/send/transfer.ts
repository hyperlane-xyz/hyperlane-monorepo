import { type TransactionReceipt } from '@ethersproject/providers';
import { stringify as yamlStringify } from 'yaml';

import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  type ChainMap,
  type ChainName,
  type CoreAddresses,
  HyperlaneCore,
  MultiProtocolCore,
  ProviderType,
  type Token,
  TokenAmount,
  type TypedTransactionReceipt,
  WarpCore,
  type WarpCoreConfig,
  WarpTxCategory,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  mustGet,
  objMap,
  parseWarpRouteMessage,
  sleep,
  timeout,
} from '@hyperlane-xyz/utils';

import { EXPLORER_URL } from '../consts.js';
import { type WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import { runSelfRelay } from '../utils/relay.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export const WarpSendLogs = {
  SUCCESS: 'Transfer was self-relayed!',
};

const SUPPORTED_PROTOCOLS = new Set<ProtocolType>([
  ProtocolType.Ethereum,
  ProtocolType.Sealevel,
  ProtocolType.Cosmos,
  ProtocolType.CosmosNative,
  ProtocolType.Starknet,
  ProtocolType.Radix,
]);

const EXPLORER_GRAPHQL_URL =
  process.env.HYPERLANE_EXPLORER_GRAPHQL_URL ??
  process.env.EXPLORER_GRAPHQL_URL ??
  'https://explorer4.hasura.app/v1/graphql';
const EXPLORER_POLL_INTERVAL_MS = 5000;
const EXPLORER_NO_RESULT_FALLBACK_COUNT = 3;

function isAnnotatedTx(value: unknown): value is AnnotatedTx {
  return typeof value === 'object' && value !== null;
}

function toTypedAltVmReceipt(
  providerType: ProviderType,
  receipt: TxReceipt,
): TypedTransactionReceipt {
  switch (providerType) {
    case ProviderType.SolanaWeb3:
    case ProviderType.CosmJs:
    case ProviderType.CosmJsWasm:
    case ProviderType.CosmJsNative:
    case ProviderType.Starknet:
    case ProviderType.Radix:
    case ProviderType.Aleo:
      // Provider SDK receipts are protocol-specific at runtime, but typed as TxReceipt.
      return {
        type: providerType,
        receipt,
      } as TypedTransactionReceipt;
    default:
      throw new Error(
        `Unsupported provider type for non-EVM transfer execution: ${providerType}`,
      );
  }
}

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

  const unsupportedChains = chains.filter(
    (chain) => !SUPPORTED_PROTOCOLS.has(multiProvider.getProtocol(chain)),
  );
  if (unsupportedChains.length > 0) {
    const chainDetails = unsupportedChains
      .map((chain) => `'${chain}' (${multiProvider.getProtocol(chain)})`)
      .join(', ');
    throw new Error(
      `Unsupported protocol for chain(s): ${chainDetails}. Supported protocols: ${[...SUPPORTED_PROTOCOLS].join(', ')}.`,
    );
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

  await runPreflightChecksForChains({
    context,
    chains,
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
          timeoutSec,
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
  timeoutSec,
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
  timeoutSec: number;
}) {
  const { multiProvider, registry, altVmSigners, multiProtocolProvider } =
    context;

  const originProtocol = multiProvider.getProtocol(origin);
  const destinationProtocol = multiProvider.getProtocol(destination);

  const signerAddress =
    originProtocol === ProtocolType.Ethereum
      ? await multiProvider.getSigner(origin).getAddress()
      : mustGet(altVmSigners, origin).getSignerAddress();
  const normalizedRecipient =
    recipient && recipient.trim().length > 0 ? recipient : undefined;

  if (!normalizedRecipient && destinationProtocol !== ProtocolType.Ethereum) {
    throw new Error(
      `Recipient address is required when sending to non-EVM destination '${destination}'`,
    );
  }

  const recipientAddress =
    normalizedRecipient ??
    (await multiProvider.getSigner(destination).getAddress());

  if (!normalizedRecipient) {
    logBlue(`No recipient specified, defaulting to: ${recipientAddress}`);
  }

  const chainAddresses = await registry.getAddresses();

  const mailboxes = objMap(chainAddresses, (_, { mailbox }) => ({ mailbox }));
  const warpMultiProvider =
    multiProtocolProvider.extendChainMetadata(mailboxes);

  const core = MultiProtocolCore.fromAddressesMap(
    chainAddresses as ChainMap<CoreAddresses>,
    warpMultiProvider,
  );

  const warpCore = WarpCore.FromConfig(warpMultiProvider, warpCoreConfig);

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

  const isCosmosOrigin =
    originProtocol === ProtocolType.Cosmos ||
    originProtocol === ProtocolType.CosmosNative;
  const skippedByUser = !!skipValidation;
  const shouldSkipTransferValidation = skippedByUser || isCosmosOrigin;
  if (isCosmosOrigin) {
    log(
      `Skipping transfer validation for ${origin} because Cosmos-origin validation is currently unsupported (CosmJS gas estimation requires sender public key).`,
    );
  } else if (skippedByUser) {
    log(
      `Skipping transfer validation for ${origin} because --skip-validation was set.`,
    );
  }

  if (!shouldSkipTransferValidation) {
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

  const txReceipts: TypedTransactionReceipt[] = [];
  let transferReceipt: TypedTransactionReceipt | null = null;
  let evmTransferReceipt: TransactionReceipt | null = null;
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5) {
      const signer = multiProvider.getSigner(origin);
      const txResponse = await signer.sendTransaction(tx.transaction);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      const typedReceipt: TypedTransactionReceipt = {
        type: ProviderType.EthersV5,
        receipt: txReceipt,
      };
      txReceipts.push(typedReceipt);
      if (tx.category === WarpTxCategory.Transfer) {
        transferReceipt = typedReceipt;
        evmTransferReceipt = txReceipt;
      }
    } else {
      const signer = mustGet(altVmSigners, origin);
      if (!isAnnotatedTx(tx.transaction)) {
        throw new Error(
          `Expected AnnotatedTx for non-EVM transfer execution, got ${typeof tx.transaction}`,
        );
      }
      const txReceipt = await signer.sendAndConfirmTransaction(tx.transaction);
      const typedReceipt = toTypedAltVmReceipt(tx.type, txReceipt);
      txReceipts.push(typedReceipt);
      if (tx.category === WarpTxCategory.Transfer) {
        transferReceipt = typedReceipt;
      }
    }
  }

  transferReceipt ||= txReceipts[txReceipts.length - 1] ?? null;
  if (!transferReceipt) {
    throw new Error('No transfer transaction receipt found');
  }

  const extracted = core.extractMessageIds(origin, transferReceipt);
  const messageId = extracted[0]?.messageId;
  if (!messageId) {
    throw new Error('No dispatched message found in transfer receipt');
  }

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipientAddress}) on ${destination}.`,
  );
  logBlue(`Message ID: ${messageId}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${messageId}`);
  if (transferReceipt.type === ProviderType.EthersV5 && evmTransferReceipt) {
    const messageIndex: number = 0;
    const message =
      HyperlaneCore.getDispatchedMessages(evmTransferReceipt)[messageIndex];
    if (message) {
      const parsed = parseWarpRouteMessage(message.parsed.body);
      log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
      log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);
    }
  }

  if (
    selfRelay &&
    (originProtocol !== ProtocolType.Ethereum ||
      destinationProtocol !== ProtocolType.Ethereum)
  ) {
    log(
      `Self-relay is only supported for EVM destinations. Skipping self-relay for ${destination}.`,
    );
    selfRelay = false;
  }

  if (selfRelay) {
    if (!evmTransferReceipt) {
      throw new Error('Missing EVM transfer receipt required for self-relay');
    }
    return runSelfRelay({
      txReceipt: evmTransferReceipt,
      multiProvider: multiProvider,
      registry: registry,
      successMessage: WarpSendLogs.SUCCESS,
    });
  }

  if (skipWaitForDelivery) return;

  const timeoutMs = timeoutSec * 1000;
  if (destinationProtocol === ProtocolType.Ethereum) {
    const delayMs = 10000;
    const maxAttempts = Math.ceil(timeoutMs / delayMs);
    await core.waitForMessagesProcessed(
      origin,
      destination,
      transferReceipt,
      delayMs,
      maxAttempts,
    );
  } else {
    try {
      await waitForExplorerDelivery(messageId, timeoutMs);
    } catch (error) {
      const message = (error as Error).message;
      if (
        message.startsWith('Explorer has no record') ||
        message.startsWith('Explorer query failed') ||
        message.startsWith('Explorer query error') ||
        message.startsWith('Explorer query returned invalid JSON') ||
        message.toLowerCase().includes('fetch failed')
      ) {
        log(
          `Explorer delivery check failed (${message}). Falling back to on-chain wait.`,
        );
        const delayMs = 10000;
        const maxAttempts = Math.ceil(timeoutMs / delayMs);
        await core.waitForMessagesProcessed(
          origin,
          destination,
          transferReceipt,
          delayMs,
          maxAttempts,
        );
      } else {
        throw error;
      }
    }
  }
  logGreen(`Transfer sent to ${destination} chain!`);
}

async function waitForExplorerDelivery(
  messageId: string,
  timeoutMs: number,
): Promise<void> {
  let noResultCount = 0;
  const maxAttempts = Math.max(
    1,
    Math.ceil(timeoutMs / EXPLORER_POLL_INTERVAL_MS),
  );
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await queryExplorerDelivered(messageId);
    if (result === 'not-found') {
      noResultCount += 1;
      if (noResultCount >= EXPLORER_NO_RESULT_FALLBACK_COUNT) {
        throw new Error('Explorer has no record of message');
      }
    } else if (result === true) {
      return;
    }

    await sleep(EXPLORER_POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for message delivery via Explorer');
}

async function queryExplorerDelivered(
  messageId: string,
): Promise<true | false | 'not-found'> {
  const body = JSON.stringify({
    query: `query MessageDelivered($id: bytea!) {
      message_view(where: { msg_id: { _eq: $id } }, limit: 1) {
        is_delivered
      }
    }`,
    variables: {
      id: messageId.replace(/^0x/i, '\\x').toLowerCase(),
    },
  });

  const response = await fetch(EXPLORER_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Explorer query failed: ${response.status} ${errorText || response.statusText}`,
    );
  }

  const payloadText = await response.text();
  let payload: {
    errors?: unknown[];
    data?: { message_view?: Array<{ is_delivered?: boolean }> };
  };
  try {
    payload = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    throw new Error(
      `Explorer query returned invalid JSON: ${payloadText || '<empty response>'}`,
    );
  }
  if (payload?.errors?.length) {
    throw new Error(`Explorer query error: ${JSON.stringify(payload.errors)}`);
  }

  const rows = payload?.data?.message_view ?? [];
  if (!rows.length) return 'not-found';
  return !!rows[0]?.is_delivered;
}
