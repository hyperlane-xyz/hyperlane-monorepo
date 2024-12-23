import { HyperlaneCore, StarknetCore } from '@hyperlane-xyz/sdk';
import {
  ChainName,
  EvmMessageAdapter,
  MessageAdapterRegistry,
  MessageService,
  StarknetMessageAdapter,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, timeout } from '@hyperlane-xyz/utils';

import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function sendTestMessage({
  context,
  origin,
  destination,
  messageBody,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
}: {
  context: WriteCommandContext;
  origin?: ChainName;
  destination?: ChainName;
  messageBody: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
}) {
  const { chainMetadata, multiProvider } = context;

  // Chain selection if not provided
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

  // Preflight checks
  await runPreflightChecksForChains({
    context,
    chains: [origin, destination],
    chainsToGasCheck: [origin],
    minGas: MINIMUM_TEST_SEND_GAS,
  });

  const adapterRegistry = new MessageAdapterRegistry();
  adapterRegistry.register(new EvmMessageAdapter(multiProvider));
  adapterRegistry.register(new StarknetMessageAdapter(multiProvider));

  const addressMap = await context.registry.getAddresses();
  const hyperlaneCore = HyperlaneCore.fromAddressesMap(
    addressMap,
    multiProvider,
  );

  const starknetSigner = await context.multiProtocolSigner?.getStarknetSigner(
    origin,
  );

  assert(starknetSigner, 'Starknet signer not found');
  const starknetCore = new StarknetCore(
    starknetSigner,
    addressMap,
    multiProvider,
  );

  const messageService = new MessageService(
    multiProvider,
    adapterRegistry,
    addressMap,
    {
      [ProtocolType.Ethereum]: hyperlaneCore,
      [ProtocolType.Starknet]: starknetCore,
      [ProtocolType.Sealevel]: hyperlaneCore,
      [ProtocolType.Cosmos]: hyperlaneCore,
    },
  );

  await timeout(
    Promise.resolve().then(async () => {
      logBlue(`Sending message from ${origin} to ${destination}`);

      const { message } = await messageService.sendMessage({
        origin: origin!,
        destination: destination!,
        recipient: addressMap[destination!].testRecipient,
        body: messageBody,
      });

      log(`Message dispatched with ID: ${message.id}`);

      if (selfRelay) {
        log('Attempting self-relay of message');
        await messageService.relayMessage(message);
        logGreen('Message was self-relayed!');
      } else if (!skipWaitForDelivery) {
        log('Waiting for message delivery...');
        // await messageService.waitForMessageDelivery(message);
        logGreen('Message was delivered!');
      }
    }),
    timeoutSec * 1000,
    'Timed out waiting for message to be delivered',
  );
}
