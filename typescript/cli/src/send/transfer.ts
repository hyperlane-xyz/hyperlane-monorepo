import crypto from 'node:crypto';

import { type TransactionReceipt } from '@ethersproject/providers';
import { stringify as yamlStringify } from 'yaml';
import { type Address, type Hex } from 'viem';

import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  type ChainMap,
  type ChainName,
  type CoreAddresses,
  FeeQuotingClient,
  FeeQuotingCommand,
  HyperlaneCore,
  MultiProtocolCore,
  ProviderType,
  type QuotedCallsParams,
  type Token,
  TokenAmount,
  TokenPullMode,
  type TypedTransactionReceipt,
  WarpCore,
  type WarpCoreConfig,
  WarpTxCategory,
  computeScopedSalt,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  addressToBytes32,
  assert,
  isEVMLike,
  mustGet,
  objFilter,
  objMap,
  parseWarpRouteMessage,
  sleep,
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

const SUPPORTED_PROTOCOLS = new Set<ProtocolType>([
  ProtocolType.Ethereum,
  ProtocolType.Tron,
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
const SEALEVEL_RECEIPT_POLL_INTERVAL_MS = 1000;
const SEALEVEL_RECEIPT_MAX_ATTEMPTS = 10;

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
      // CAST: Provider SDK receipts are the correct protocol-specific shape at runtime,
      // but TxReceipt is typed as { [key: string]: any } so the union cast is unavoidable.
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

export async function fetchSealevelReceiptWithLogs(
  context: Pick<WriteCommandContext, 'multiProtocolProvider'>,
  origin: ChainName,
  signature: string,
  pollIntervalMs = SEALEVEL_RECEIPT_POLL_INTERVAL_MS,
  maxAttempts = SEALEVEL_RECEIPT_MAX_ATTEMPTS,
): Promise<TypedTransactionReceipt> {
  assert(
    Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0,
    `Invalid Sealevel receipt poll interval: ${pollIntervalMs}`,
  );
  assert(
    Number.isInteger(maxAttempts) && maxAttempts > 0,
    `Invalid Sealevel receipt maxAttempts: ${maxAttempts}`,
  );
  const connection =
    context.multiProtocolProvider.getSolanaWeb3Provider(origin);
  let receipt = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      receipt = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }

    if (receipt?.meta?.logMessages?.length) {
      return {
        type: ProviderType.SolanaWeb3,
        receipt,
      };
    }

    if (attempt < maxAttempts - 1) {
      await sleep(pollIntervalMs);
    }
  }

  const suffix =
    lastError === undefined
      ? ''
      : ` (last getTransaction error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
  throw new Error(
    `Transaction logs unavailable for Solana transaction ${signature}${suffix}`,
  );
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
  sourceToken,
  destinationToken,
  feeQuotingUrl,
  feeQuotingApiKey,
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
  sourceToken?: string;
  destinationToken?: string;
  feeQuotingUrl?: string;
  feeQuotingApiKey?: string;
}) {
  const { multiProvider } = context;

  assert(
    chains.length >= 2,
    'At least two chains are required to send a warp transfer',
  );

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

  // Non-EVM chains can only be the final destination (we need EVM signers
  // for intermediate hops and can't resolve recipients for non-EVM intermediates).
  for (let i = 0; i < chains.length - 1; i++) {
    const hopDest = chains[i + 1];
    if (
      i < chains.length - 2 &&
      !isEVMLike(multiProvider.getProtocol(hopDest))
    ) {
      throw new Error(
        `Non-EVM chain '${hopDest}' cannot be an intermediate hop. ` +
          `Non-EVM chains are only supported as the final destination.`,
      );
    }
  }

  const finalDestination = chains[chains.length - 1];
  const normalizedRecipient =
    recipient && recipient.trim().length > 0 ? recipient.trim() : undefined;

  // Validate once up front to avoid partial multi-hop sends before failing.
  if (
    !normalizedRecipient &&
    !isEVMLike(multiProvider.getProtocol(finalDestination))
  ) {
    throw new Error(
      `Recipient address is required when sending to non-EVM destination '${finalDestination}'`,
    );
  }

  // Only preflight-check chains where we have signers (hop origins + EVM
  // destinations when self-relaying). Non-EVM final destinations don't need
  // signers since the relayer handles delivery.
  const signerChains = chains.filter((chain, i) => {
    // All hop origins need signers
    if (i < chains.length - 1) return true;
    // Final destination only needs a signer for EVM self-relay
    return selfRelay && isEVMLike(multiProvider.getProtocol(chain));
  });

  if (signerChains.length > 0) {
    await runPreflightChecksForChains({
      context,
      chains: signerChains,
      minGas: GasAction.TEST_SEND_GAS,
    });
  }

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
          sourceToken: i === 0 ? sourceToken : undefined,
          destinationToken:
            i === chains.length - 2 ? destinationToken : undefined,
          feeQuotingUrl,
          feeQuotingApiKey,
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
  sourceToken: sourceTokenAddr,
  destinationToken: destTokenAddr,
  feeQuotingUrl,
  feeQuotingApiKey,
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
  sourceToken?: string;
  destinationToken?: string;
  feeQuotingUrl?: string;
  feeQuotingApiKey?: string;
}) {
  const { multiProvider, registry, altVmSigners, multiProtocolProvider } =
    context;

  const originProtocol = multiProvider.getProtocol(origin);
  const destinationProtocol = multiProvider.getProtocol(destination);

  const signerAddress = isEVMLike(originProtocol)
    ? await multiProvider.getSigner(origin).getAddress()
    : mustGet(altVmSigners, origin).getSignerAddress();
  const normalizedRecipient =
    recipient && recipient.trim().length > 0 ? recipient.trim() : undefined;

  if (!normalizedRecipient && !isEVMLike(destinationProtocol)) {
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

  const mailboxes = objMap(
    objFilter(
      chainAddresses,
      (_, addresses): addresses is typeof addresses => !!addresses?.mailbox,
    ),
    (_, { mailbox }) => ({ mailbox }),
  );
  const warpMultiProvider =
    multiProtocolProvider.extendChainMetadata(mailboxes);

  // CAST: Registry addresses include CoreAddresses fields (mailbox) for all deployed chains.
  // The warp route config guarantees origin/destination have core deployments.
  const core = MultiProtocolCore.fromAddressesMap(
    chainAddresses as ChainMap<CoreAddresses>,
    warpMultiProvider,
  );

  const warpCore = WarpCore.FromConfig(warpMultiProvider, warpCoreConfig);

  let token: Token;
  const tokensForRoute = warpCore.getTokensForRoute(origin, destination);
  if (sourceTokenAddr) {
    const found = warpCore.findToken(origin, sourceTokenAddr);
    assert(found, `Source token ${sourceTokenAddr} not found on ${origin}`);
    token = found;
  } else if (tokensForRoute.length === 0) {
    logRed(`No Warp Routes found from ${origin} to ${destination}`);
    throw new Error('Error finding warp route');
  } else if (tokensForRoute.length === 1) {
    token = tokensForRoute[0];
  } else {
    logBlue(`Please select a token from the Warp config`);
    const routerAddress = await runTokenSelectionStep(tokensForRoute);
    const found = warpCore.findToken(origin, routerAddress);
    assert(found, `Token not found for ${routerAddress} on ${origin}`);
    token = found;
  }

  let destToken: Token | undefined;
  if (destTokenAddr) {
    const found = warpCore.findToken(destination, destTokenAddr);
    assert(
      found,
      `Destination token ${destTokenAddr} not found on ${destination}`,
    );
    destToken = found;
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
      destinationToken: destToken,
    });
    if (errors) {
      logRed('Error validating transfer', JSON.stringify(errors));
      throw new Error('Error validating transfer');
    }
  }

  // Build QuotedCalls params if fee-quoting is configured
  let quotedCalls: QuotedCallsParams | undefined;
  if (feeQuotingUrl && !feeQuotingApiKey) {
    log(
      'Warning: --fee-quoting-url provided without --fee-quoting-api-key, skipping fee quoting',
    );
  }
  if (feeQuotingUrl && feeQuotingApiKey) {
    const chainAddressesForOrigin = chainAddresses[origin];
    const quotedCallsAddress = chainAddressesForOrigin?.quotedCalls as
      | Address
      | undefined;
    assert(
      quotedCallsAddress,
      `No quotedCalls address found for chain ${origin}`,
    );

    const clientSalt = `0x${crypto.randomBytes(32).toString('hex')}` as Hex;
    const salt = computeScopedSalt(signerAddress as Address, clientSalt);
    const destinationDomainId = multiProvider.getDomainId(destination);

    const feeQuotingClient = new FeeQuotingClient({
      baseUrl: feeQuotingUrl,
      apiKey: feeQuotingApiKey,
    });

    const command = destToken
      ? FeeQuotingCommand.TransferRemoteTo
      : FeeQuotingCommand.TransferRemote;

    logBlue('Fetching offchain fee quotes...');
    const { quotes } = await feeQuotingClient.getQuote({
      origin,
      command,
      router: token.addressOrDenom as Address,
      destination: destinationDomainId,
      salt,
      recipient: addressToBytes32(recipient!) as Hex,
    });

    quotedCalls = {
      address: quotedCallsAddress,
      quotes,
      clientSalt,
      tokenPullMode: TokenPullMode.TransferFrom,
    };

    logBlue(`Got ${quotes.length} quote(s), estimating fees...`);
    const { feeQuotes } = await warpCore.getQuotedTransferFee({
      originTokenAmount: new TokenAmount(amount, token),
      destination,
      sender: signerAddress,
      recipient: recipient!,
      quotedCalls,
      destinationToken: destToken,
    });
    quotedCalls.feeQuotes = feeQuotes;
  }

  // TODO: override hook address for self-relay
  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
    destination,
    sender: signerAddress,
    recipient: recipientAddress,
    destinationToken: destToken,
    quotedCalls,
  });

  const txReceipts: TypedTransactionReceipt[] = [];
  let transferReceipt: TypedTransactionReceipt | null = null;
  let evmTransferReceipt: TransactionReceipt | null = null;
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5 || tx.type === ProviderType.Tron) {
      const signer = multiProvider.getSigner(origin);
      const preparedTx = await multiProvider.prepareTx(origin, tx.transaction);
      const txResponse = await signer.sendTransaction(preparedTx);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      const typedReceipt: TypedTransactionReceipt = {
        type: tx.type,
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
      const txReceipt = await signer.sendAndConfirmTransaction(
        tx.type === ProviderType.SolanaWeb3 && 'extraSigners' in tx
          ? { ...tx.transaction, extraSigners: tx.extraSigners }
          : tx.transaction,
      );
      const typedReceipt =
        tx.type === ProviderType.SolanaWeb3
          ? await fetchSealevelReceiptWithLogs(
              context,
              origin,
              txReceipt.signature,
              SEALEVEL_RECEIPT_POLL_INTERVAL_MS,
              Math.max(
                SEALEVEL_RECEIPT_MAX_ATTEMPTS,
                Math.ceil(
                  (timeoutSec * 1000) / SEALEVEL_RECEIPT_POLL_INTERVAL_MS,
                ),
              ),
            )
          : toTypedAltVmReceipt(tx.type, txReceipt);
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
    // Same-chain transfers don't dispatch an interchain message.
    if (origin === destination) {
      logGreen(`Same-chain transfer on ${origin} completed.`);
      return;
    }
    throw new Error('No dispatched message found in transfer receipt');
  }

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipientAddress}) on ${destination}.`,
  );
  logBlue(`Message ID: ${messageId}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${messageId}`);
  if (
    (transferReceipt.type === ProviderType.EthersV5 ||
      transferReceipt.type === ProviderType.Tron) &&
    evmTransferReceipt
  ) {
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
    (!isEVMLike(originProtocol) || !isEVMLike(destinationProtocol))
  ) {
    const nonEvmSide = !isEVMLike(originProtocol) ? origin : destination;
    log(
      `Self-relay requires both origin and destination to be EVM-like. '${nonEvmSide}' is not. Skipping self-relay.`,
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
  if (isEVMLike(destinationProtocol)) {
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
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.startsWith('Explorer has no record') ||
        message.startsWith('Explorer query failed') ||
        message.startsWith('Explorer query error') ||
        message.startsWith('Explorer query returned invalid JSON') ||
        message.startsWith('Timed out waiting for message delivery') ||
        message.toLowerCase().includes('fetch failed')
      ) {
        try {
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
        } catch (fallbackError) {
          const fallbackMsg =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          if (fallbackMsg.includes('not implemented')) {
            warnYellow(
              `On-chain delivery polling not supported for '${destination}' (${destinationProtocol}). ` +
                `Track at ${EXPLORER_URL}/message/${messageId}`,
            );
            return;
          } else {
            throw fallbackError;
          }
        }
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
    } else {
      // result === false: message found but not yet delivered — reset counter
      noResultCount = 0;
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
