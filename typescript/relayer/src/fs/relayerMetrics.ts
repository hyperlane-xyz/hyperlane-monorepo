import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metric registry for the relayer
 */
export const relayerMetricsRegistry = new Registry();

/**
 * Total number of messages processed by the relayer
 */
export const relayerMessagesTotal = new Counter({
  name: 'hyperlane_relayer_messages_total',
  help: 'Total number of messages processed by the relayer',
  registers: [relayerMetricsRegistry],
  labelNames: ['origin_chain', 'destination_chain', 'status'] as const,
});

/**
 * Total number of retry attempts for failed messages
 */
export const relayerRetriesTotal = new Counter({
  name: 'hyperlane_relayer_retries_total',
  help: 'Total number of retry attempts for failed messages',
  registers: [relayerMetricsRegistry],
  labelNames: ['origin_chain', 'destination_chain'] as const,
});

/**
 * Current size of the message backlog
 */
export const relayerBacklogSize = new Gauge({
  name: 'hyperlane_relayer_backlog_size',
  help: 'Current number of messages in the relay backlog',
  registers: [relayerMetricsRegistry],
});

/**
 * Time taken to relay a message (in seconds)
 */
export const relayerRelayDuration = new Histogram({
  name: 'hyperlane_relayer_relay_duration_seconds',
  help: 'Time taken to relay a message in seconds',
  registers: [relayerMetricsRegistry],
  labelNames: ['origin_chain', 'destination_chain'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
});

/**
 * Number of messages skipped due to whitelist filtering
 */
export const relayerMessagesSkipped = new Counter({
  name: 'hyperlane_relayer_messages_skipped_total',
  help: 'Total number of messages skipped due to whitelist filtering',
  registers: [relayerMetricsRegistry],
  labelNames: ['origin_chain', 'destination_chain'] as const,
});

/**
 * Number of messages already delivered (no relay needed)
 */
export const relayerMessagesAlreadyDelivered = new Counter({
  name: 'hyperlane_relayer_messages_already_delivered_total',
  help: 'Total number of messages that were already delivered',
  registers: [relayerMetricsRegistry],
  labelNames: ['origin_chain', 'destination_chain'] as const,
});

/**
 * Helper class for recording relayer metrics
 */
export class RelayerMetrics {
  recordMessageSuccess(originChain: string, destinationChain: string): void {
    relayerMessagesTotal
      .labels({
        origin_chain: originChain,
        destination_chain: destinationChain,
        status: 'success',
      })
      .inc();
  }

  recordMessageFailure(originChain: string, destinationChain: string): void {
    relayerMessagesTotal
      .labels({
        origin_chain: originChain,
        destination_chain: destinationChain,
        status: 'failure',
      })
      .inc();
  }

  recordRetry(originChain: string, destinationChain: string): void {
    relayerRetriesTotal
      .labels({
        origin_chain: originChain,
        destination_chain: destinationChain,
      })
      .inc();
  }

  updateBacklogSize(size: number): void {
    relayerBacklogSize.set(size);
  }

  recordRelayDuration(
    originChain: string,
    destinationChain: string,
    durationSeconds: number,
  ): void {
    relayerRelayDuration
      .labels({
        origin_chain: originChain,
        destination_chain: destinationChain,
      })
      .observe(durationSeconds);
  }

  recordMessageSkipped(originChain: string, destinationChain: string): void {
    relayerMessagesSkipped
      .labels({
        origin_chain: originChain,
        destination_chain: destinationChain,
      })
      .inc();
  }

  recordMessageAlreadyDelivered(
    originChain: string,
    destinationChain: string,
  ): void {
    relayerMessagesAlreadyDelivered
      .labels({
        origin_chain: originChain,
        destination_chain: destinationChain,
      })
      .inc();
  }

  /**
   * Start a timer for measuring relay duration
   * Returns a function that should be called when the relay completes
   */
  startRelayTimer(originChain: string, destinationChain: string): () => number {
    const startTime = Date.now();
    return () => {
      const durationSeconds = (Date.now() - startTime) / 1000;
      this.recordRelayDuration(originChain, destinationChain, durationSeconds);
      return durationSeconds;
    };
  }
}
