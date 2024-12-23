import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneAddressesMap } from '../contracts/types.js';
import { HyperlaneCore } from '../core/HyperlaneCore.js';
import { StarknetCore } from '../core/StarknetCore.js';
import { DispatchedMessage } from '../core/types.js';
import { MessageAdapterRegistry } from '../messaging/MessageAdapterRegistry.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

export class MessageService {
  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly adapterRegistry: MessageAdapterRegistry,
    private readonly chainAddresses: HyperlaneAddressesMap<any>,
    private readonly cores: Record<ProtocolType, HyperlaneCore | StarknetCore>,
  ) {}

  async sendMessage({
    origin,
    destination,
    recipient,
    body,
    selfRelay = false,
  }: {
    origin: ChainName;
    destination: ChainName;
    recipient: string;
    body: string;
    selfRelay?: boolean;
  }) {
    const originProtocol = this.multiProvider.getProtocol(origin);
    const destinationProtocol = this.multiProvider.getProtocol(destination);

    const adapter = this.adapterRegistry.getAdapter(originProtocol);
    const core = this.cores[originProtocol];

    const { metadata, body: formattedBody } =
      await adapter.formatMessageForDispatch({
        body,
        destinationProtocol,
      });

    return core.sendMessage(
      origin,
      destination,
      recipient,
      formattedBody,
      selfRelay ? this.chainAddresses[origin].merkleTreeHook : undefined,
      metadata,
    );
  }

  async relayMessage(message: DispatchedMessage) {
    const originProtocol = this.multiProvider.getProtocol(
      message.parsed.originChain!,
    );
    const destinationProtocol = this.multiProvider.getProtocol(
      message.parsed.destinationChain!,
    );

    const adapter = this.adapterRegistry.getAdapter(originProtocol);
    const core = this.cores[destinationProtocol];

    const { messageData, metadata } = await adapter.formatMessageForRelay(
      message,
    );

    if (
      originProtocol === ProtocolType.Starknet ||
      (destinationProtocol === ProtocolType.Starknet && messageData)
    ) {
      message.message = messageData;
    }

    return core.deliver(message, metadata);
  }
}
