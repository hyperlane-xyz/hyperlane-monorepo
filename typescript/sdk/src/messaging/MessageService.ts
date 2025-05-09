import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../core/HyperlaneCore.js';
import { StarknetCore } from '../core/StarknetCore.js';
import { DispatchedMessage } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { getMessageMetadata, translateMessage } from './messageUtils.js';

export class MessageService {
  constructor(
    protected readonly multiProvider: MultiProvider,
    private readonly cores: Partial<
      Record<ProtocolType, HyperlaneCore | StarknetCore>
    >,
  ) {}

  async sendMessage({
    origin,
    destination,
    recipient,
    body,
  }: {
    origin: ChainName;
    destination: ChainName;
    recipient: string;
    body: string;
  }) {
    const originProtocol = this.multiProvider.getProtocol(origin);
    const core = this.getProtocolCoreOrFail(originProtocol);

    return core.sendMessage(origin, destination, recipient, body);
  }

  async relayMessage(message: DispatchedMessage) {
    const originProtocol = this.multiProvider.getProtocol(
      message.parsed.origin!,
    );
    const destinationProtocol = this.multiProvider.getProtocol(
      message.parsed.destination!,
    );
    const core = this.getProtocolCoreOrFail(destinationProtocol);

    const messageData = translateMessage(
      message,
      originProtocol,
      destinationProtocol,
    );

    return core.deliver(
      messageData ? { ...message, message: messageData } : message,
      getMessageMetadata(destinationProtocol),
    );
  }

  async awaitMessagesDelivery(
    message: DispatchedMessage,
    delay?: number,
    maxAttempts?: number,
  ) {
    const destinationProtocol = this.multiProvider.getProtocol(
      message.parsed.destination!,
    );
    const core = this.getProtocolCoreOrFail(destinationProtocol);

    await core.waitForMessageIdProcessed(
      message.id,
      this.multiProvider.getChainName(message.parsed.destination!),
      delay,
      maxAttempts,
    );
  }

  private getProtocolCoreOrFail(protocol: ProtocolType) {
    const core = this.cores[protocol];
    if (!core) throw new Error(`No core for ${protocol}`);
    return core;
  }
}
