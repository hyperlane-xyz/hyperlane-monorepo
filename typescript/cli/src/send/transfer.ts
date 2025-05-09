// import { stubMerkleTreeConfig } from '../utils/relay.js';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainName,
  DispatchedMessage,
  HyperlaneCore,
  MessageService,
  MultiProtocolProvider,
  ProviderType,
  StarknetCore,
  StarknetCoreAdapter,
  Token,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, timeout } from '@hyperlane-xyz/utils';

import { EXPLORER_URL, MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
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
}: {
  context: WriteCommandContext;
  warpCoreConfig: WarpCoreConfig;
  chains: ChainName[];
  amount: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  await runPreflightChecksForChains({
    context,
    chains,
    minGas: MINIMUM_TEST_SEND_GAS,
  });

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
  const { multiProvider, registry, multiProtocolProvider, chainMetadata } =
    context;

  const chainAddresses = await registry.getAddresses();

  // Create protocol-specific cores map
  const protocolCores: Partial<
    Record<ProtocolType, HyperlaneCore | StarknetCore>
  > = {};

  // Initialize cores for the chains
  for (const chain of [origin, destination]) {
    const protocol: ProtocolType = chainMetadata[chain].protocol;
    if (!protocolCores[protocol]) {
      if (protocol === ProtocolType.Starknet) {
        protocolCores[protocol] = new StarknetCore(
          chainAddresses,
          multiProvider,
          context.multiProtocolSigner!,
          context.multiProtocolProvider!,
        );
      } else {
        protocolCores[protocol] = HyperlaneCore.fromAddressesMap(
          chainAddresses,
          multiProvider,
        );
      }
    }
  }

  const messageService = new MessageService(multiProvider, protocolCores);

  const { signerAddress, recipientAddress } =
    await getSignerAndRecipientAddresses({
      context,
      origin,
      destination,
      recipient,
    });

  recipient ||= recipientAddress;
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

  // TODO: override hook address for self-relay
  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
    destination,
    sender: signerAddress,
    recipient,
  });

  const txReceipts = [];
  for (const tx of transferTxs) {
    const txReceipt = await executeTxByType(tx, origin, context, multiProvider);
    txReceipts.push(txReceipt);
  }

  const transferTxReceipt = txReceipts[txReceipts.length - 1];
  const messageIndex: number = 0;

  if ('transaction_hash' in transferTxReceipt) {
    const coreAdapter = new StarknetCoreAdapter(
      origin,
      multiProtocolProvider!,
      { mailbox: chainAddresses['starknetsepolia'].mailbox },
    );
    const messageIds = coreAdapter.extractMessageIds({
      receipt: transferTxReceipt,
      type: ProviderType.Starknet,
    });
    logBlue(`Message IDs: ${messageIds}`);
  }

  const message = parseMessageFromReceipt(
    transferTxReceipt,
    origin,
    messageIndex,
    protocolCores,
  );

  // const parsedBody = message?.parsed?.body
  //   ? parseWarpRouteMessage(message.parsed.body)
  //   : null;

  // if (parsedBody) {
  //   log(`Body:\n${indentYamlOrJson(yamlStringify(parsedBody, null, 2), 4)}`);
  // }

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);

  if (selfRelay) {
    log('Attempting self-relay of message');
    await messageService.relayMessage(message);
    logGreen(WarpSendLogs.SUCCESS);
  } else if (!skipWaitForDelivery) {
    log('Waiting for message delivery...');
    await messageService.awaitMessagesDelivery(message, 10000, 60);
    logGreen('Transfer sent to destination chain!');
  }
}

async function executeTxByType(
  tx: any,
  chain: ChainName,
  context: WriteCommandContext,
  multiProvider: any,
) {
  switch (tx.type) {
    case ProviderType.EthersV5: {
      return executeEthersTransaction(tx, chain, multiProvider);
    }
    case ProviderType.Starknet: {
      return executeStarknetTransaction(tx, chain, context);
    }
    default:
      throw new Error(`Unsupported provider type: ${tx.type}`);
  }
}

async function executeEthersTransaction(
  tx: any,
  chain: ChainName,
  multiProvider: any,
) {
  const signer = multiProvider.getSigner(chain);
  const provider = multiProvider.getProvider(chain);
  const connectedSigner = signer.connect(provider);
  const txResponse = await connectedSigner.sendTransaction(tx.transaction);
  return multiProvider.handleTx(chain, txResponse);
}

async function executeStarknetTransaction(
  tx: any,
  chain: ChainName,
  context: WriteCommandContext,
) {
  const starknetSigner = context.multiProtocolSigner!.getStarknetSigner(chain)!;
  const txResponse = await starknetSigner.execute([tx.transaction as any]);
  return starknetSigner.waitForTransaction(txResponse.transaction_hash);
}

function parseMessageFromReceipt(
  receipt: any,
  origin: ChainName,
  messageIndex: number,
  protocolCores: Partial<Record<ProtocolType, HyperlaneCore | StarknetCore>>,
): DispatchedMessage {
  if ('transaction_hash' in receipt) {
    return (
      protocolCores.starknet! as StarknetCore
    ).parseDispatchedMessagesFromReceipt(receipt, origin);
  }

  return HyperlaneCore.getDispatchedMessages(receipt)[messageIndex];
}

async function getSignerAndRecipientAddresses({
  context,
  origin,
  destination,
  recipient,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  recipient?: string;
}): Promise<{
  signerAddress: string;
  recipientAddress: string;
}> {
  const { multiProvider } = context;
  const originMetadata = multiProvider.getChainMetadata(origin);
  const destinationMetadata = multiProvider.getChainMetadata(destination);

  // Get signer address based on origin protocol
  let signerAddress: string;
  if (originMetadata.protocol === ProtocolType.Starknet) {
    const starknetSigner =
      context.multiProtocolSigner!.getStarknetSigner(origin);
    signerAddress = starknetSigner.address;
  } else {
    // EVM-based chains
    const evmSigner = multiProvider.getSigner(origin);
    signerAddress = await evmSigner.getAddress();
  }

  // Get recipient address based on destination protocol
  let recipientAddress: string;
  if (recipient) {
    recipientAddress = recipient;
  } else if (destinationMetadata.protocol === ProtocolType.Starknet) {
    const starknetSigner =
      context.multiProtocolSigner!.getStarknetSigner(destination);
    recipientAddress = starknetSigner.address;
  } else {
    // EVM-based chains
    const evmSigner = multiProvider.getSigner(destination);
    recipientAddress = await evmSigner.getAddress();
  }

  return {
    signerAddress,
    recipientAddress,
  };
}
