import { Logger } from 'pino';

import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import {
  formatParsedStarknetMessageForEthereum,
  translateMessage as translateMessageUtil,
} from '../messaging/messageUtils.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  MessageBusConfig,
  MessageHandler,
  MessageWithStatus,
} from './types.js';

/**
 * Default configuration for the message bus
 */
const DEFAULT_CONFIG: MessageBusConfig = {
  maxAttempts: 10,
  retryTimeout: 1000, // 1 second retry timeout
};

/**
 * A message bus that manages the routing and delivery of cross-protocol messages
 */
export class MessageBus {
  private readonly config: MessageBusConfig;
  protected readonly multiProvider: MultiProvider;
  private backlog: MessageWithStatus[] = [];
  private handlers: Map<ProtocolType, MessageHandler[]> = new Map();
  private readonly logger: Logger;
  private isProcessing = false;
  private processingInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Creates a new MessageBus
   * @param config Configuration options
   * @param multiProvider The multi-provider instance
   * @param logger Optional logger instance
   */
  constructor(
    multiProvider: MultiProvider,
    config?: Partial<MessageBusConfig>,
    logger?: Logger,
  ) {
    this.multiProvider = multiProvider;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = (logger || rootLogger).child({ module: 'MessageBus' });
  }

  /**
   * Registers a message handler for a specific protocol
   * @param handler The handler to register
   */
  registerHandler(handler: MessageHandler): void {
    if (!this.handlers.has(handler.protocol)) {
      this.handlers.set(handler.protocol, []);
    }

    this.handlers.get(handler.protocol)!.push(handler);
    this.logger.info(`Registered handler for protocol ${handler.protocol}`);
  }

  /**
   * Publishes a message to the message bus
   * @param message The base dispatched message to publish
   */
  publish(message: MessageWithStatus): void {
    // Don't add duplicates based on message ID
    if (this.backlog.some((m) => m.id === message.id)) {
      this.logger.debug(`Message ${message.id} already in backlog, skipping`);
      return;
    }

    this.backlog.push(message);
    this.logger.info(
      `Added message ${message.id} to backlog (${this.backlog.length} total)`,
    );
  }

  /**
   * Starts the message bus processing loop
   * @param intervalMs How often to check for new messages, in milliseconds
   */
  start(intervalMs = 1000): void {
    if (this.processingInterval) {
      this.logger.warn('Message bus already started');
      return;
    }

    this.logger.info('Starting message bus');
    this.processingInterval = setInterval(() => {
      this.processNextBatch().catch((err) => {
        this.logger.error({ err }, 'Error processing message batch');
      });
    }, intervalMs);
  }

  /**
   * Stops the message bus processing loop
   */
  stop(): void {
    if (!this.processingInterval) {
      this.logger.warn('Message bus not started');
      return;
    }

    this.logger.info('Stopping message bus');
    clearInterval(this.processingInterval);
    this.processingInterval = null;
  }

  /**
   * Returns the current backlog of messages
   */
  getBacklog(): MessageWithStatus[] {
    return [...this.backlog];
  }

  /**
   * Process a batch of pending messages
   */
  private async processNextBatch(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // Get pending messages that are ready to be processed
      const now = Date.now();
      const messagesToProcess = this.backlog.filter((message) => {
        if (message.status !== 'pending') {
          return false;
        }

        // Apply backoff if this isn't the first attempt
        if (message.attempts > 0) {
          const backoffTime = message.attempts * this.config.retryTimeout;
          return now - message.lastAttempt > backoffTime;
        }

        return true;
      });

      if (messagesToProcess.length === 0) {
        return;
      }

      this.logger.debug(`Processing ${messagesToProcess.length} messages`);

      // Process each message
      for (const message of messagesToProcess) {
        await this.processMessage(message);
      }

      // Clean up delivered/failed messages
      this.cleanupBacklog();
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(message: MessageWithStatus): Promise<void> {
    const { id, parsed } = message;
    const destinationDomain = parsed.destination;
    const originDomain = parsed.origin;

    // Find the destination chain name and protocol
    const destinationChain =
      this.multiProvider.tryGetChainName(destinationDomain);
    const destinationProtocol = this.multiProvider.tryGetProtocol(
      destinationChain!,
    );

    // Find the origin chain name and protocol
    const originChain = this.multiProvider.tryGetChainName(originDomain);
    const originProtocol = this.multiProvider.tryGetProtocol(originChain!);

    // Update status and attempt count
    message.status = 'processing';
    message.attempts += 1;
    message.lastAttempt = Date.now();

    const handlers = this.handlers.get(destinationProtocol!) || [];

    if (handlers.length === 0) {
      this.logger.warn(
        `No handlers registered for protocol ${destinationProtocol}, message ${id} cannot be processed`,
      );
      message.status = 'failed';
      return;
    }

    // Try each handler until one succeeds
    let processed = false;
    for (const handler of handlers) {
      try {
        this.logger.debug(
          `Attempting to process message ${id} with handler for ${handler.protocol}`,
        );

        // Translate the message if the origin protocol is different from the destination protocol
        let translatedMessage = message;
        if (
          originProtocol &&
          destinationProtocol &&
          originProtocol !== destinationProtocol
        ) {
          translatedMessage = this.translateMessage(
            message,
            originProtocol,
            destinationProtocol,
          );
          // translate message.parsed
          translatedMessage.parsed = {
            ...translatedMessage.parsed,
            recipient: translatedMessage.parsed.recipient,
            sender: translatedMessage.parsed.sender,
          };

          this.logger.debug(
            `Translated message ${id} from ${originProtocol} to ${destinationProtocol}`,
          );
        }

        processed = await handler.processMessage(translatedMessage);

        if (processed) {
          this.logger.info(`Successfully processed message ${id}`);
          message.status = 'delivered';
          break;
        }
      } catch (error) {
        this.logger.error(
          { error },
          `Error processing message ${id} with handler for ${handler.protocol}`,
        );
      }
    }

    // If no handler succeeded and we've reached the max attempts, mark as failed
    if (message.status === 'processing') {
      if (message.attempts >= this.config.maxAttempts) {
        this.logger.error(
          `Failed to process message ${id} after ${message.attempts} attempts, marking as failed`,
        );
        message.status = 'failed';
      } else {
        this.logger.info(
          `Message ${id} processing attempt ${message.attempts} failed, will retry later`,
        );
        message.status = 'pending';
      }
    }
  }

  /**
   * Translates a message between protocols
   * @param message The message to translate
   * @param originProtocol The origin protocol
   * @param destinationProtocol The destination protocol
   * @returns The translated message
   */
  private translateMessage(
    message: MessageWithStatus,
    originProtocol: ProtocolType,
    destinationProtocol: ProtocolType,
  ): MessageWithStatus {
    // Create a shallow copy of the message
    const translatedMessage = { ...message };

    // Special case handling for Starknet to Ethereum translation
    if (
      originProtocol === ProtocolType.Starknet &&
      destinationProtocol === ProtocolType.Ethereum &&
      message.parsed
    ) {
      this.logger.debug(
        `Translating Starknet message ${message.id} to Ethereum format`,
      );

      // TODO: fix types
      const formattedParsed = formatParsedStarknetMessageForEthereum(
        message.parsed as any,
      );

      translatedMessage.parsed = formattedParsed;
    }

    // Standard translation flow for other protocol combinations
    const translatedPayload = translateMessageUtil(
      message,
      originProtocol,
      destinationProtocol,
    );

    // Update the message with the translated payload
    translatedMessage.message = translatedPayload;

    return translatedMessage;
  }

  /**
   * Remove delivered/failed messages from the backlog
   */
  private cleanupBacklog(): void {
    // Keep pending/processing messages, remove delivered/failed ones
    const oldLength = this.backlog.length;
    this.backlog = this.backlog.filter(
      (message) =>
        message.status === 'pending' || message.status === 'processing',
    );

    const removedCount = oldLength - this.backlog.length;
    if (removedCount > 0) {
      this.logger.debug(
        `Removed ${removedCount} processed messages from backlog`,
      );
    }
  }
}
