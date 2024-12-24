import { Logger } from 'pino';

import { ProtocolType, rootLogger, sleep } from '@hyperlane-xyz/utils';

import { HyperlaneAddressesMap } from '../contracts/types.js';
import { HyperlaneCore } from '../core/HyperlaneCore.js';
import { StarknetCore } from '../core/StarknetCore.js';
import { DispatchedMessage } from '../core/types.js';
import { MessageAdapterRegistry } from '../messaging/MessageAdapterRegistry.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

interface DeliveryStatus {
  delivered: boolean;
  attempts: number;
  lastError?: Error;
}

export class MessageService {
  readonly logger: Logger = rootLogger.child({
    module: 'MessageService',
  });

  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly adapterRegistry: MessageAdapterRegistry,
    private readonly chainAddresses: HyperlaneAddressesMap<any>,
    private readonly cores: Partial<
      Record<ProtocolType, HyperlaneCore | StarknetCore>
    > = {},
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
    const core = this.cores[originProtocol];

    if (!core) {
      throw new Error(`No core found for protocol ${originProtocol}`);
    }

    const destinationProtocol = this.multiProvider.getProtocol(destination);
    const adapter = this.adapterRegistry.getAdapter(originProtocol);

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
    const core = this.cores[destinationProtocol];

    if (!core) {
      throw new Error(`No core found for protocol ${destinationProtocol}`);
    }

    const adapter = this.adapterRegistry.getAdapter(originProtocol);

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

  async waitForMessageDelivery(
    message: DispatchedMessage,
    options: {
      initialPollIntervalMs?: number;
      maxPollIntervalMs?: number;
      maxAttempts?: number;
      backoffFactor?: number;
    } = {},
  ): Promise<void> {
    const {
      initialPollIntervalMs = 5000,
      maxPollIntervalMs = 30000,
      maxAttempts = 100,
      backoffFactor = 1.5,
    } = options;

    let attempts = 0;
    let currentInterval = initialPollIntervalMs;

    while (attempts < maxAttempts) {
      attempts++;

      const status = await this.isMessageDelivered(message);

      if (status.delivered) {
        return;
      }

      if (status.lastError) {
        this.logger.info(
          `Delivery check attempt ${attempts} failed: ${status.lastError.message}`,
        );
      }

      // Implement exponential backoff with max limit
      currentInterval = Math.min(
        currentInterval * backoffFactor,
        maxPollIntervalMs,
      );

      await sleep(currentInterval);
    }

    throw new Error(
      `Message delivery not confirmed after ${maxAttempts} attempts`,
    );
  }

  async isMessageDelivered(
    message: DispatchedMessage,
  ): Promise<DeliveryStatus> {
    const destinationProtocol = this.multiProvider.getProtocol(
      message.parsed.destinationChain!,
    );
    const destinationAdapter =
      this.adapterRegistry.getAdapter(destinationProtocol);
    if (!destinationAdapter) {
      throw new Error(
        `No adapter found for destination chain ${message.parsed.destinationChain}`,
      );
    }

    try {
      const receipt = await destinationAdapter.getMessageDeliveryStatus(
        message,
      );
      return {
        delivered: receipt.delivered,
        attempts: receipt.attempts || 0,
      };
    } catch (error) {
      return {
        delivered: false,
        attempts: 0,
        lastError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
