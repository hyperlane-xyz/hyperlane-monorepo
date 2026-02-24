import { stringify as yamlStringify } from 'yaml';

import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  type ChainMap,
  type ChainName,
  type CoreAddresses,
  type EthersV5TransactionReceipt,
  HyperlaneCore,
  KeypairSvmTransactionSigner,
  MultiProtocolCore,
  MultiProtocolProvider,
  ProviderType,
  type SolanaWeb3TransactionReceipt,
  SvmMultiProtocolSignerAdapter,
  type Token,
  TokenAmount,
  type TypedTransactionReceipt,
  WarpCore,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  base58ToBuffer,
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

const SUPPORTED_PROTOCOLS = new Set([
  ProtocolType.Ethereum,
  ProtocolType.Sealevel,
]);

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

  const unsupportedChains = chains.filter(
    (chain) => !SUPPORTED_PROTOCOLS.has(multiProvider.getProtocol(chain)),
  );
  if (unsupportedChains.length > 0) {
    const chainDetails = unsupportedChains
      .map((chain) => `'${chain}' (${multiProvider.getProtocol(chain)})`)
      .join(', ');
    throw new Error(
      `'hyperlane warp send' only supports EVM and Sealevel chains. Unsupported chains: ${chainDetails}`,
    );
  }

  const evmChains = chains.filter(
    (chain) => multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
  );
  if (evmChains.length > 0) {
    await runPreflightChecksForChains({
      context,
      chains: evmChains,
      minGas: GasAction.TEST_SEND_GAS,
    });
  }

  for (let i = 0; i < chains.length; i++) {
    const origin = chains[i];
    const destination = chains[i + 1];

    if (destination) {
      logBlue(`Sending a message from ${origin} to ${destination}`);
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
          skipValidation,
        }),
        timeoutSec * 1000,
        'Timed out waiting for messages to be delivered',
      );
    }
  }
}

/**
 * Parse a Sealevel private key string into a Uint8Array.
 * Supports JSON array (solana-keygen), base58, and hex formats.
 */
function parseSealevelKey(keyStr: string): Uint8Array {
  try {
    const parsed = JSON.parse(keyStr);
    if (Array.isArray(parsed)) {
      return new Uint8Array(parsed);
    }
  } catch {
    // Not JSON — try base58 then hex
  }
  const base58Bytes = base58ToBuffer(keyStr);
  if (base58Bytes.length === 64) {
    return new Uint8Array(base58Bytes);
  }
  return Buffer.from(keyStr, 'hex');
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
  const originProtocol = multiProvider.getProtocol(origin);
  const destProtocol = multiProvider.getProtocol(destination);

  const multiProtocolProvider =
    MultiProtocolProvider.fromMultiProvider(multiProvider);

  // Resolve signer address per protocol
  let signerAddress: string;
  let svmSigner: SvmMultiProtocolSignerAdapter | undefined;

  if (originProtocol === ProtocolType.Sealevel) {
    const sealevelKey = context.key[ProtocolType.Sealevel];
    assert(sealevelKey, 'Sealevel private key required (--key.sealevel)');
    const keypairSigner = new KeypairSvmTransactionSigner(
      parseSealevelKey(sealevelKey),
    );
    svmSigner = new SvmMultiProtocolSignerAdapter(
      origin,
      keypairSigner,
      multiProtocolProvider,
    );
    signerAddress = await svmSigner.address();
  } else {
    const signer = multiProvider.getSigner(origin);
    signerAddress = await signer.getAddress();
  }

  // Resolve recipient address
  if (!recipient) {
    if (destProtocol === ProtocolType.Sealevel) {
      const sealevelKey = context.key[ProtocolType.Sealevel];
      assert(
        sealevelKey,
        'Sealevel private key required for recipient address (--key.sealevel)',
      );
      const destKeypairSigner = new KeypairSvmTransactionSigner(
        parseSealevelKey(sealevelKey),
      );
      recipient = destKeypairSigner.publicKey.toBase58();
    } else {
      const recipientSigner = multiProvider.getSigner(destination);
      recipient = await recipientSigner.getAddress();
    }
  }

  const chainAddresses = await registry.getAddresses();

  // Inject mailbox addresses into MPP metadata for Sealevel chains
  for (const chain of [origin, destination]) {
    const addresses = chainAddresses[chain];
    if (addresses?.mailbox) {
      (multiProtocolProvider.metadata[chain] as any).mailbox =
        addresses.mailbox;
    }
  }

  const multiProtocolCore = MultiProtocolCore.fromAddressesMap(
    chainAddresses as ChainMap<CoreAddresses>,
    multiProtocolProvider,
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
      recipient,
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
    recipient,
  });

  // Submit transactions and collect typed receipts
  const typedReceipts: TypedTransactionReceipt[] = [];
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5) {
      const signer = multiProvider.getSigner(origin);
      const txResponse = await signer.sendTransaction(tx.transaction);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      typedReceipts.push({
        type: ProviderType.EthersV5,
        receipt: txReceipt,
      } as EthersV5TransactionReceipt);
    } else if (tx.type === ProviderType.SolanaWeb3) {
      assert(svmSigner, 'SVM signer not initialized for Sealevel transaction');
      const signature = await svmSigner.sendAndConfirmTransaction(tx);
      const connection = multiProtocolProvider.getSolanaWeb3Provider(origin);
      const solReceipt = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      assert(solReceipt, `Failed to fetch Sealevel transaction: ${signature}`);
      typedReceipts.push({
        type: ProviderType.SolanaWeb3,
        receipt: solReceipt,
      } as SolanaWeb3TransactionReceipt);
    }
  }

  assert(typedReceipts.length > 0, 'No transaction receipts collected');
  const lastTypedReceipt = typedReceipts[typedReceipts.length - 1];

  // Extract message IDs using multi-protocol core
  const messageIds = multiProtocolCore.extractMessageIds(
    origin,
    lastTypedReceipt,
  );
  assert(messageIds.length > 0, 'No messages found in transaction receipt');

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  for (const { messageId } of messageIds) {
    logBlue(`Message ID: ${messageId}`);
    logBlue(`Explorer Link: ${EXPLORER_URL}/message/${messageId}`);
  }

  // Log message body details for EVM origins (full message available)
  if (lastTypedReceipt.type === ProviderType.EthersV5) {
    const message = HyperlaneCore.getDispatchedMessages(
      lastTypedReceipt.receipt,
    )[0];
    const parsed = parseWarpRouteMessage(message.parsed.body);
    log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
    log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);
  }

  if (selfRelay) {
    if (originProtocol !== ProtocolType.Ethereum) {
      warnYellow(
        `Self-relay is only supported for EVM origins. Skipping for ${origin} (${originProtocol}).`,
      );
    } else {
      return runSelfRelay({
        txReceipt: (lastTypedReceipt as EthersV5TransactionReceipt).receipt,
        multiProvider: multiProvider,
        registry: registry,
        successMessage: WarpSendLogs.SUCCESS,
      });
    }
  }

  if (skipWaitForDelivery) return;

  // Max wait 10 minutes
  await multiProtocolCore.waitForMessagesProcessed(
    origin,
    destination,
    lastTypedReceipt,
    10000,
    60,
  );
  logGreen(`Transfer sent to ${destination} chain!`);
}
