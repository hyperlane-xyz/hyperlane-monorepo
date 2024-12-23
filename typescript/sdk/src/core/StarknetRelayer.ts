import { utils } from 'ethers';

import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { MessageBus } from '../messaging/MessageBus.js';
import { prepareMessageForRelay } from '../messaging/messageUtils.js';

import { StarknetCore } from './StarknetCore.js';
import { DispatchedMessage } from './types.js';

export class StarknetRelayer {
  protected logger = rootLogger.child({ module: 'StarknetRelayer' });
  private messageBus = new MessageBus();
  private unsubscribe?: () => void;

  constructor(private readonly core: StarknetCore) {}

  async relayMessage(
    message: DispatchedMessage,
  ): Promise<{ transaction_hash: string }> {
    this.logger.info(`Preparing to relay message ${message.id}`);

    const { metadata, messageData } = prepareMessageForRelay(
      message,
      ProtocolType.Starknet,
    );

    if (messageData) {
      message.message = utils.hexlify(messageData);
    }

    return this.core.deliver(message, metadata);
  }

  start(): void {
    if (this.unsubscribe) return;

    // Subscribe to core events
    const { removeHandler } = this.core.onDispatch(async (message) => {
      this.messageBus.publish(message);
    });

    // Subscribe to message bus
    const messageHandler = async (message: DispatchedMessage) => {
      try {
        await this.relayMessage(message);
      } catch (error) {
        this.logger.error(`Failed to relay message ${message.id}: ${error}`);
      }
    };

    const unsubscribeFromBus = this.messageBus.subscribe(messageHandler);

    this.unsubscribe = () => {
      removeHandler();
      unsubscribeFromBus();
    };
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
}
