import { ProtocolType } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../core/types.js';

/**
 * Represents the processing state of a message in the message bus
 */
export type MessageStatus = 'pending' | 'processing' | 'delivered' | 'failed';

/**
 * Configuration for the message bus
 */
export interface MessageBusConfig {
  /** Maximum number of delivery attempts before marking a message as failed */
  maxAttempts: number;

  /** Base timeout between retry attempts in milliseconds */
  retryTimeout: number;
}

/**
 * Extended dispatch message type with processing metadata
 */
export interface MessageWithStatus extends DispatchedMessage {
  /** Number of delivery attempts made */
  attempts: number;

  /** Timestamp of the last delivery attempt */
  lastAttempt: number;

  /** Transaction hash of the dispatch transaction */
  dispatchTx: string;

  /** Current status of message processing */
  status: MessageStatus;
}

/**
 * Interface for message handlers that process messages for specific protocols
 */
export interface MessageHandler {
  /** The protocol type this handler can process */
  protocol: ProtocolType;

  /**
   * Process a message destined for this handler's protocol
   * @param message The message to process
   * @returns true if successfully processed, false otherwise
   */
  processMessage(message: MessageWithStatus): Promise<boolean>;
}
