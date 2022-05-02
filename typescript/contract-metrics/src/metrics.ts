import Logger from 'bunyan';
import express, { Response } from 'express';
import { Gauge, collectDefaultMetrics, register } from 'prom-client';

export class MetricCollector {
  private numDispatchedGauge: Gauge<string>;
  private numProcessedGauge: Gauge<string>;
  private numUnprocessedGauge: Gauge<string>;
  private outboxStateGauge: Gauge<string>;
  private governorRecoveryActiveAt: Gauge<string>;

  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;

    this.numDispatchedGauge = new Gauge({
      name: 'abacus_number_messages_dispatched',
      help: 'Gauge that indicates how many messages have been dispatched for a network.',
      labelNames: ['network', 'environment'],
    });

    this.numProcessedGauge = new Gauge({
      name: 'abacus_number_messages_processed',
      help: 'Gauge that indicates how many messages have been processed for a network.',
      labelNames: ['network', 'environment'],
    });

    this.numUnprocessedGauge = new Gauge({
      name: 'abacus_number_messages_unprocessed',
      help: 'Gauge that indicates how many messages are unprocessed for a network.',
      labelNames: ['network', 'environment'],
    });

    this.outboxStateGauge = new Gauge({
      name: 'abacus_outbox_state',
      help: 'Gauge that tracks the state of a outbox contract for a network',
      labelNames: ['network', 'environment'],
    });

    this.governorRecoveryActiveAt = new Gauge({
      name: 'abacus_governor_recovery_active_at',
      help: 'Gauge that tracks the timestamp (seconds) of the governor recovery mode being active',
      labelNames: ['network', 'environment'],
    });
  }
  /**
   * Sets the state for a bridge.
   */
  setBridgeState(
    network: string,
    environment: string,
    dispatched: number,
    processed: number,
    unprocessed: number,
  ) {
    this.numDispatchedGauge.set({ network, environment }, dispatched);
    this.numProcessedGauge.set({ network, environment }, processed);
    this.numUnprocessedGauge.set({ network, environment }, unprocessed);
  }

  setOutboxState(network: string, environment: string, state: number) {
    this.outboxStateGauge.set({ network, environment }, state);
  }

  setGovernorRecoveryActiveAt(
    network: string,
    environment: string,
    recoveryActiveAt: number,
  ) {
    this.governorRecoveryActiveAt.set(
      { network, environment },
      recoveryActiveAt,
    );
  }

  /**
   * Starts a server that exposes metrics in the prometheus format
   */
  startServer(port: number) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw Error(`Invalid PrometheusPort value: ${port}`);
    }
    const server = express();
    server.get('/metrics', async (_, res: Response) => {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    });
    // Enable collection of default metrics
    collectDefaultMetrics();

    this.logger.info(
      {
        endpoint: `http://0.0.0.0:${port}/metrics`,
      },
      'Prometheus metrics exposed',
    );
    server.listen(port);
  }
}
