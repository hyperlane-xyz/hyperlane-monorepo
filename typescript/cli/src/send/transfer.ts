import { stringify as yamlStringify } from 'yaml';

import {
  ChainName,
  DispatchedMessage,
  EvmMessageAdapter,
  HyperlaneCore,
  MessageAdapterRegistry,
  MessageService,
  MultiProtocolProvider,
  ProviderType,
  StarknetCore,
  StarknetMessageAdapter,
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

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { indentYamlOrJson } from '../utils/files.js';
// import { stubMerkleTreeConfig } from '../utils/relay.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export const WarpSendLogs = {
  SUCCESS: 'Transfer was self-relayed!',
};

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
  origin?: ChainName; // resolved in signerMiddleware
  destination?: ChainName; // resolved in signerMiddleware
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

  await runPreflightChecksForChains({
    context,
    chains: [origin, destination],
    chainsToGasCheck: [origin],
    minGas: MINIMUM_TEST_SEND_GAS,
  });

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
  const { multiProvider, registry } = context;
  const { chainMetadata } = context;

  // Setup MessageService and adapters
  const adapterRegistry = new MessageAdapterRegistry();
  adapterRegistry.register(new EvmMessageAdapter(multiProvider));
  adapterRegistry.register(new StarknetMessageAdapter(multiProvider));

  const chainAddresses = await registry.getAddresses();

  // Create protocol-specific cores map
  const protocolCores: Partial<
    Record<ProtocolType, HyperlaneCore | StarknetCore>
  > = {};

  // Helper to get protocol type for a chain
  const getProtocolType = (chain: ChainName) => chainMetadata[chain].protocol;

  // Initialize cores for the chains
  for (const chain of [origin, destination]) {
    const protocol = getProtocolType(chain);
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

  const messageService = new MessageService(
    multiProvider,
    adapterRegistry,
    chainAddresses,
    protocolCores,
  );

  const signer = multiProvider.getSigner(origin);
  const recipientSigner =
    context.multiProtocolSigner!.getStarknetSigner(destination);

  const recipientAddress = recipientSigner.address;
  const signerAddress = await signer.getAddress();

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

  // const errors = await warpCore.validateTransfer({
  //   originTokenAmount: token.amount(amount),
  //   destination,
  //   recipient,
  //   sender: signerAddress,
  // });
  // if (errors) {
  //   logRed('Error validating transfer', JSON.stringify(errors));
  //   throw new Error('Error validating transfer');
  // }

  // TODO: override hook address for self-relay
  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
    destination,
    sender: signerAddress,
    recipient,
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
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
  log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);

  logBlue(`Message dispatched with ID: ${message.id}`);

  if (selfRelay) {
    log('Attempting self-relay of message');
    await messageService.relayMessage(message);
    logGreen(WarpSendLogs.SUCCESS);
  } else if (!skipWaitForDelivery) {
    log('Waiting for message delivery...');
    await messageService.waitForMessageDelivery(message);
    logGreen('Transfer sent to destination chain!');
  }
}
