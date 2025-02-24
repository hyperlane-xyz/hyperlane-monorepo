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
  Token,
  TokenAmount,
  WarpCore,
  WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  parseWarpRouteMessage,
  timeout,
} from '@hyperlane-xyz/utils';

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
  const { multiProvider, registry } = context;
  const { chainMetadata } = context;

  const chainAddresses = await registry.getAddresses();

  // Create protocol-specific cores map
  const protocolCores: Partial<
    Record<ProtocolType, HyperlaneCore | StarknetCore>
  > = {};

  // Initialize cores for the chains
  for (const chain of [origin, destination]) {
    const protocol = chainMetadata[chain].protocol;
    if (!protocolCores[protocol]) {
      if (protocol === ProtocolType.Starknet) {
        protocolCores[protocol] = new StarknetCore(
          chainAddresses,
          multiProvider,
          context.multiProtocolSigner!,
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
    let txReceipt;

    switch (tx.type) {
      case ProviderType.EthersV5: {
        const signer = multiProvider.getSigner(origin);
        const provider = multiProvider.getProvider(origin);
        const connectedSigner = signer.connect(provider);
        const txResponse = await connectedSigner.sendTransaction(
          tx.transaction,
        );
        txReceipt = await multiProvider.handleTx(origin, txResponse);
        break;
      }
      case ProviderType.Starknet: {
        const starknetSigner =
          context.multiProtocolSigner!.getStarknetSigner(origin)!;

        const txResponse = await starknetSigner.execute([
          tx.transaction as any,
        ]);

        txReceipt = await starknetSigner.waitForTransaction(
          txResponse.transaction_hash,
        );

        break;
      }
      default:
        throw new Error(`Unsupported provider type: ${tx.type}`);
    }

    txReceipts.push(txReceipt);
  }

  const transferTxReceipt = txReceipts[txReceipts.length - 1];
  const messageIndex: number = 0;
  let message: DispatchedMessage;
  let parsed: any;
  if ('transaction_hash' in transferTxReceipt) {
    message = (
      protocolCores.starknet! as StarknetCore
    ).parseDispatchedMessagesFromReceipt(transferTxReceipt, origin);
  } else {
    message = HyperlaneCore.getDispatchedMessages(transferTxReceipt as any)[
      messageIndex
    ];
    parsed = parseWarpRouteMessage(message.parsed.body);
    log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);
  }

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);

  logBlue(`Message dispatched with ID: ${message.id}`);

  if (selfRelay) {
    log('Attempting self-relay of message');
    await messageService.relayMessage(message);
    logGreen(WarpSendLogs.SUCCESS);
  } else if (!skipWaitForDelivery) {
    // log('Waiting for message delivery...');
    // await messageService.waitForMessageDelivery(message);
    logGreen('Transfer sent to destination chain!');
  }
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
