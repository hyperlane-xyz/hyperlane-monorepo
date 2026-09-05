import { expect } from 'chai';
import { pino } from 'pino';
import { Registry } from 'prom-client';

import {
  MultiProtocolProvider,
  Token,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';

import { createWarpMetricsGauges } from './gauges.js';
import { updateTokenBalanceMetrics } from './update.js';

function collect(level: string, valueUSD: number | undefined) {
  const registry = new Registry();
  const records: string[] = [];
  const logger = pino(
    { level },
    {
      write: (record: string) => {
        records.push(record);
      },
    },
  );
  const tokens = Array.from(
    { length: 20 },
    (_, index) =>
      new Token({
        chainName: `chain${index}`,
        standard: TokenStandard.EvmHypCollateral,
        addressOrDenom: `0x${String(index + 1).padStart(40, '0')}`,
        decimals: 18,
        symbol: 'TOKEN',
        name: 'Token',
      }),
  );
  const warpCore = new WarpCore(new MultiProtocolProvider({}), tokens);
  updateTokenBalanceMetrics(
    createWarpMetricsGauges(registry),
    warpCore,
    tokens[0]!,
    { balance: 3, valueUSD, tokenAddress: tokens[0]!.addressOrDenom },
    'TEST/metric-logging',
    logger,
  );
  return { registry, records };
}

describe('value-at-risk log volume', () => {
  it('retains every metric while emitting only per-token observations at info', async () => {
    const info = collect('info', 12);
    const debug = collect('debug', 12);
    expect(info.records).to.have.length(2);
    expect(debug.records).to.have.length(22);
    expect(info.records[0]).to.include('Wallet balance updated for token');
    expect(info.records[1]).to.include('Wallet value updated for token');
    expect(
      debug.records.filter((record) => record.includes('Value at risk on ')),
    ).to.have.length(20);
    expect(await info.registry.metrics()).to.equal(
      await debug.registry.metrics(),
    );
    const values = (
      await info.registry
        .getSingleMetric('hyperlane_warp_route_value_at_risk')!
        .get()
    ).values;
    expect(values).to.have.length(20);
    expect(values.every(({ value }) => value === 12)).to.equal(true);
  });

  it('preserves zero USD values and the balance-only path without a price', async () => {
    const zero = collect('info', 0);
    const missing = collect('info', undefined);
    expect(zero.records).to.have.length(2);
    const zeroValues = (
      await zero.registry
        .getSingleMetric('hyperlane_warp_route_value_at_risk')!
        .get()
    ).values;
    expect(zeroValues.every(({ value }) => value === 0)).to.equal(true);
    expect(missing.records).to.have.length(1);
    const missingValues = (
      await missing.registry
        .getSingleMetric('hyperlane_warp_route_value_at_risk')!
        .get()
    ).values;
    expect(missingValues).to.have.length(0);
  });
});
