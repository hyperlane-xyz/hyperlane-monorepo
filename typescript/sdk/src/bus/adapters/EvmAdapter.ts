import { Logger } from 'pino';

import {
  Address,
  ProtocolType,
  bytes32ToAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { getMessageMetadata } from '../../messaging/messageUtils.js';
import { ChainMap } from '../../types.js';
import { MessageHandler, MessageWithStatus } from '../types.js';

/**
 * Adapter for handling messages between EVM chains
 */
export class EvmAdapter implements MessageHandler {
  protocol = ProtocolType.Ethereum;
  protected logger: Logger;
  protected core: HyperlaneCore;
  protected whitelist: ChainMap<Set<Address>> | undefined;

  /**
   * Creates a new EvmAdapter
   * @param core The Hyperlane core instance
   * @param whitelist Optional whitelist of addresses to filter messages
   * @param logger Optional logger instance
   */
  constructor(
    core: HyperlaneCore,
    whitelist?: ChainMap<Address[]>,
    logger?: Logger,
  ) {
    this.core = core;
    this.logger = (logger || rootLogger).child({ module: 'EvmAdapter' });

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
   * Register this adapter to listen for messages from Hyperlane core
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
        // if (this.whitelist && !this.messageMatchesWhitelist(message.parsed)) {
        //   this.logger.debug(
        //     `Skipping message ${message.id} - doesn't match whitelist`,
        //   );
        //   return;
        // }

        const enrichedMessage = this.enrichMessage(message, event);
        messageBus.publish(enrichedMessage);
      },
      chainNames,
    );

    return () => removeHandler(chainNames);
  }

  /**
   * Process a message destined for an EVM chain
   * @param message The message to process
   * @returns true if successful, false otherwise
   */
  async processMessage(message: MessageWithStatus): Promise<boolean> {
    try {
      // TODO: Implement EVM message processing
      //   // Get ISM metadata
      //   const ism = await this.core.getRecipientIsmConfig(message);
      //   const hook = await this.core.getHookConfig(message);

      //   // Use the metadataBuilder from the core to build the metadata
      //   const metadata = await (this.core as any).metadataBuilder.build({
      //     message,
      //     ism,
      //     hook,
      //     dispatchTx: { transactionHash: message.dispatchTx },
      //   });

      await this.core.deliver(
        message,
        getMessageMetadata(ProtocolType.Ethereum), // Evals to '0x001'
      );
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
    event: any,
  ): MessageWithStatus {
    return {
      ...message,
      attempts: 0,
      lastAttempt: Date.now(),
      dispatchTx: event.transactionHash,
      status: 'pending',
    };
  }

  /**
   * Check if a message matches the whitelist
   */
  protected messageMatchesWhitelist(message: any): boolean {
    if (!this.whitelist) {
      return true;
    }

    const originAddresses =
      this.whitelist[message.originChain ?? message.origin];
    if (!originAddresses) {
      return false;
    }

    const sender = bytes32ToAddress(message.sender);
    if (originAddresses.size !== 0 && !originAddresses.has(sender)) {
      return false;
    }

    const destinationAddresses =
      this.whitelist[message.destinationChain ?? message.destination];
    if (!destinationAddresses) {
      return false;
    }

    const recipient = bytes32ToAddress(message.recipient);
    if (
      destinationAddresses.size !== 0 &&
      !destinationAddresses.has(recipient)
    ) {
      return false;
    }

    return true;
  }
}
