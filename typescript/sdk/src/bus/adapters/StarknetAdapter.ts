import { Logger } from 'pino';
import { ParsedEvent } from 'starknet';

import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetCore } from '../../core/StarknetCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { getMessageMetadata } from '../../messaging/messageUtils.js';
import { ChainMap } from '../../types.js';
import { MessageHandler, MessageWithStatus } from '../types.js';

/**
 * Adapter for handling messages between Starknet chains
 */
export class StarknetAdapter implements MessageHandler {
  protocol = ProtocolType.Starknet;
  protected logger: Logger;
  protected core: StarknetCore;
  protected whitelist: ChainMap<Set<Address>> | undefined;

  /**
   * Creates a new StarknetAdapter
   * @param core The Starknet core instance
   * @param whitelist Optional whitelist of addresses to filter messages
   * @param logger Optional logger instance
   */
  constructor(
    core: StarknetCore,
    whitelist?: ChainMap<Address[]>,
    logger?: Logger,
  ) {
    this.core = core;
    this.logger = (logger || rootLogger).child({ module: 'StarknetAdapter' });

    if (whitelist) {
      this.whitelist = Object.fromEntries(
        Object.entries(whitelist).map(([chain, addresses]) => [
          chain,
          new Set(addresses as Address[]),
        ]),
      );
    }
  }

  /**
   * Register this adapter to listen for messages from Starknet core
   * and publish them to the message bus
   * @param messageBus The message bus to publish to
   * @returns A function to stop listening
   */
  listenForMessages(messageBus: {
    publish: (message: MessageWithStatus) => void;
  }): () => void {
    const chainNames = this.whitelist ? Object.keys(this.whitelist) : undefined;

    const { removeHandler } = this.core.onDispatch(
      async (message: DispatchedMessage, event: any) => {
        // Note: Currently not implementing whitelist for Starknet messages
        // We could implement this logic similar to the EvmAdapter once
        // whitelist filtering for Starknet is fully implemented in StarknetCore

        const enrichedMessage = this.enrichMessage(message, event);
        messageBus.publish(enrichedMessage);
      },
      chainNames,
    );

    return () => removeHandler(chainNames);
  }

  /**
   * Process a message destined for a Starknet chain
   * @param message The message to process
   * @returns true if successful, false otherwise
   */
  async processMessage(message: MessageWithStatus): Promise<boolean> {
    try {
      // Get metadata for message delivery
      const metadata = getMessageMetadata(ProtocolType.Starknet);

      // Deliver the message
      await this.core.deliver(message, metadata);
      return true;
    } catch (error) {
      this.logger.error({ error }, `Error processing message ${message.id}`);
      return false;
    }
  }

  /**
   * Add status tracking fields to a dispatched message
   */
  protected enrichMessage(
    message: DispatchedMessage,
    event: ParsedEvent,
  ): MessageWithStatus {
    return {
      ...message,
      attempts: 0,
      lastAttempt: Date.now(),
      dispatchTx: event.transaction_hash ?? '',
      status: 'pending',
    };
  }
}
