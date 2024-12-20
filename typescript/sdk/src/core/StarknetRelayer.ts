import { ParsedMessage, ProtocolType, assert } from '@hyperlane-xyz/utils';
import { rootLogger } from '@hyperlane-xyz/utils';

import { StarknetCore } from './StarknetCore.js';
import { DispatchedMessage } from './types.js';

export class StarknetRelayer {
  protected logger = rootLogger.child({ module: 'StarknetRelayer' });

  protected readonly core: StarknetCore;
  protected readonly retryTimeout: number;
  protected backlog: Array<{
    attempts: number;
    lastAttempt: number;
    message: any;
    dispatchTx: string;
  }> = [];

  protected stopRelayingHandler: (() => void) | undefined;

  constructor({
    core,
    retryTimeout = 1000,
  }: {
    core: StarknetCore;
    retryTimeout?: number;
  }) {
    this.core = core;
    this.retryTimeout = retryTimeout;
  }

  /**
   * Prepare message and metadata for relay
   */
  prepareMessageForRelay(message: DispatchedMessage): {
    metadata: { size: number; data: bigint[] };
    messageData?: Uint8Array;
  } {
    const destinationChain = message.parsed.destinationChain!;
    const destinationProtocol =
      this.core.multiProvider.getProtocol(destinationChain);

    if (destinationProtocol === ProtocolType.Ethereum) {
      // Convert Starknet message to EVM format
      const ethMessage = StarknetCore.toEthMessageBytes(
        message.parsed as ParsedMessage & {
          body: { size: bigint; data: bigint[] };
        },
      );

      // For EVM destinations, metadata is empty
      return {
        metadata: { size: 0, data: [] },
        messageData: ethMessage,
      };
    } else {
      // For Starknet destinations, use simple metadata
      return {
        metadata: { size: 1, data: [BigInt(1)] },
      };
    }
  }

  /**
   * Relay a message to its destination chain
   */
  async relayMessage(
    message: DispatchedMessage,
  ): Promise<{ transaction_hash: string }> {
    this.logger.info(`Preparing to relay message ${message.id}`);

    const { metadata, messageData } = this.prepareMessageForRelay(message);

    const destinationChain = message.parsed.destinationChain!;
    this.logger.info(`Relaying message to ${destinationChain} chain`);

    return this.core.deliver(message, metadata, messageData);
  }

  start(): void {
    assert(!this.stopRelayingHandler, 'Relayer already started');

    // Subscribe to dispatch events
    this.core
      .onDispatch(async (message, event) => {
        this.backlog.push({
          attempts: 0,
          lastAttempt: Date.now(),
          message,
          dispatchTx: event.transaction_hash,
        });
      })
      .then(({ removeHandler }) => {
        this.stopRelayingHandler = () => removeHandler();
      });
  }

  stop(): void {
    if (this.stopRelayingHandler) {
      this.stopRelayingHandler();
      this.stopRelayingHandler = undefined;
    }
  }
}
