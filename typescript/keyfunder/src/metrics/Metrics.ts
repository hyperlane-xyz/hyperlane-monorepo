import * as http from 'http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { ChainBalanceReport, FundingAction } from '../types';

export class KeyfunderMetrics {
  public readonly registry: Registry;

  public readonly balanceGauge: Gauge<string>;
  public readonly fundingActionsTotal: Counter<string>;
  public readonly fundingAmountTotal: Counter<string>;
  public readonly cycleDurationSeconds: Histogram<string>;
  public readonly cycleErrorsTotal: Counter<string>;
  public readonly lastCycleTimestamp: Gauge<string>;

  private server?: http.Server;

  constructor() {
    this.registry = new Registry();

    // Default nodejs runtime metrics
    collectDefaultMetrics({ register: this.registry });

    this.balanceGauge = new Gauge({
      name: 'keyfunder_balance_gauge',
      help: 'Current account balance in native units (decimal float)',
      labelNames: ['chain', 'protocol', 'address', 'type'],
      registers: [this.registry],
    });

    this.fundingActionsTotal = new Counter({
      name: 'keyfunder_funding_actions_total',
      help: 'Total funding actions processed by status',
      labelNames: ['chain', 'protocol', 'strategy', 'status'],
      registers: [this.registry],
    });

    this.fundingAmountTotal = new Counter({
      name: 'keyfunder_funding_amount_total',
      help: 'Total native amount funded across all recipients',
      labelNames: ['chain', 'protocol', 'strategy'],
      registers: [this.registry],
    });

    this.cycleDurationSeconds = new Histogram({
      name: 'keyfunder_cycle_duration_seconds',
      help: 'Duration of keyfunder funding cycle in seconds',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });

    this.cycleErrorsTotal = new Counter({
      name: 'keyfunder_cycle_errors_total',
      help: 'Total errors encountered during funding cycle',
      labelNames: ['chain', 'error_type'],
      registers: [this.registry],
    });

    this.lastCycleTimestamp = new Gauge({
      name: 'keyfunder_last_cycle_timestamp_seconds',
      help: 'Unix timestamp of the last executed funding cycle',
      registers: [this.registry],
    });
  }

  /**
   * Record balance metrics from ChainBalanceReport
   */
  public recordBalances(reports: Record<string, ChainBalanceReport>): void {
    for (const [chain, report] of Object.entries(reports)) {
      if (report.funderAddress) {
        const funderBal = parseFloat(report.formattedFunderBalance) || 0;
        this.balanceGauge.set(
          {
            chain,
            protocol: report.protocol,
            address: report.funderAddress,
            type: 'funder',
          },
          funderBal
        );
      }

      for (const rec of report.recipientBalances) {
        const recBal = parseFloat(rec.formattedBalance) || 0;
        this.balanceGauge.set(
          {
            chain,
            protocol: report.protocol,
            address: rec.recipient,
            type: 'recipient',
          },
          recBal
        );
      }
    }
  }

  /**
   * Record funding action execution results
   */
  public recordActions(actions: FundingAction[]): void {
    for (const action of actions) {
      this.fundingActionsTotal.inc({
        chain: action.chain,
        protocol: action.protocol,
        strategy: action.strategy,
        status: action.status.toLowerCase(),
      });

      if (action.status === 'EXECUTED' && action.formattedRequiredFunding) {
        const amount = parseFloat(action.formattedRequiredFunding) || 0;
        this.fundingAmountTotal.inc(
          {
            chain: action.chain,
            protocol: action.protocol,
            strategy: action.strategy,
          },
          amount
        );
      }
    }
  }

  /**
   * Record cycle error
   */
  public recordError(chain: string, errorType: string): void {
    this.cycleErrorsTotal.inc({ chain, error_type: errorType });
  }

  /**
   * Start HTTP metrics and health check server
   */
  public async startServer(port: number = 9090): Promise<http.Server> {
    if (this.server) {
      return this.server;
    }

    const server = http.createServer(async (req, res) => {
      const url = req.url || '/';

      if (url === '/metrics') {
        try {
          const metrics = await this.registry.metrics();
          res.setHeader('Content-Type', this.registry.contentType);
          res.writeHead(200);
          res.end(metrics);
        } catch (err: any) {
          res.writeHead(500);
          res.end(err.message);
        }
      } else if (url === '/healthz' || url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    return new Promise((resolve, reject) => {
      server.listen(port, () => {
        this.server = server;
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  /**
   * Stop HTTP metrics server
   */
  public async stopServer(): Promise<void> {
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          this.server = undefined;
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}
