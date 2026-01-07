import { Gauge, Pushgateway, Registry } from 'prom-client';

import type { MetricsConfig } from '../config/types.js';

export class KeyFunderMetrics {
  private registry: Registry;
  private pushGateway: Pushgateway | null = null;

  readonly walletBalanceGauge: Gauge<string>;
  readonly fundingAmountGauge: Gauge<string>;
  readonly igpBalanceGauge: Gauge<string>;
  readonly sweepAmountGauge: Gauge<string>;
  readonly operationDurationGauge: Gauge<string>;

  constructor(
    private readonly config: MetricsConfig | undefined,
    private readonly baseLabels: Record<string, string> = {},
  ) {
    this.registry = new Registry();

    const labelNames = ['chain', 'address', 'role', ...Object.keys(baseLabels)];

    this.walletBalanceGauge = new Gauge({
      name: 'hyperlane_keyfunder_wallet_balance',
      help: 'Current wallet balance in native token',
      labelNames,
      registers: [this.registry],
    });

    this.fundingAmountGauge = new Gauge({
      name: 'hyperlane_keyfunder_funding_amount',
      help: 'Amount funded to a key',
      labelNames,
      registers: [this.registry],
    });

    this.igpBalanceGauge = new Gauge({
      name: 'hyperlane_keyfunder_igp_balance',
      help: 'IGP contract balance',
      labelNames: ['chain', ...Object.keys(baseLabels)],
      registers: [this.registry],
    });

    this.sweepAmountGauge = new Gauge({
      name: 'hyperlane_keyfunder_sweep_amount',
      help: 'Amount swept to safe address',
      labelNames: ['chain', ...Object.keys(baseLabels)],
      registers: [this.registry],
    });

    this.operationDurationGauge = new Gauge({
      name: 'hyperlane_keyfunder_operation_duration_seconds',
      help: 'Duration of funding operations',
      labelNames: ['chain', 'operation', ...Object.keys(baseLabels)],
      registers: [this.registry],
    });

    if (config?.pushGateway) {
      this.pushGateway = new Pushgateway(config.pushGateway, [], this.registry);
    }
  }

  recordWalletBalance(
    chain: string,
    address: string,
    role: string,
    balance: number,
  ): void {
    this.walletBalanceGauge.set(
      { chain, address, role, ...this.baseLabels },
      balance,
    );
  }

  recordFundingAmount(
    chain: string,
    address: string,
    role: string,
    amount: number,
  ): void {
    this.fundingAmountGauge.set(
      { chain, address, role, ...this.baseLabels },
      amount,
    );
  }

  recordIgpBalance(chain: string, balance: number): void {
    this.igpBalanceGauge.set({ chain, ...this.baseLabels }, balance);
  }

  recordSweepAmount(chain: string, amount: number): void {
    this.sweepAmountGauge.set({ chain, ...this.baseLabels }, amount);
  }

  recordOperationDuration(
    chain: string,
    operation: string,
    durationSeconds: number,
  ): void {
    this.operationDurationGauge.set(
      { chain, operation, ...this.baseLabels },
      durationSeconds,
    );
  }

  async push(): Promise<void> {
    if (!this.pushGateway) {
      return;
    }

    const jobName = this.config?.jobName ?? 'keyfunder';
    await this.pushGateway.push({ jobName });
  }

  getRegistry(): Registry {
    return this.registry;
  }
}
