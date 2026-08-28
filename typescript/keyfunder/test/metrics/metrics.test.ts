import { expect } from 'chai';
import { KeyfunderMetrics } from '../../src/metrics/metrics';
import { ChainBalanceReport, FundingAction } from '../../src/types';

describe('KeyfunderMetrics', () => {
  let metrics: KeyfunderMetrics;

  beforeEach(() => {
    metrics = new KeyfunderMetrics();
  });

  afterEach(async () => {
    await metrics.stopServer();
  });

  it('should register and record balance gauges', async () => {
    const reports: Record<string, ChainBalanceReport> = {
      ethereum: {
        chain: 'ethereum',
        protocol: 'ethereum',
        funderAddress: '0xFunder',
        funderBalance: 10000000000000000000n,
        formattedFunderBalance: '10.0',
        recipientBalances: [
          {
            recipient: '0xRec1',
            balance: 1000000000000000000n,
            formattedBalance: '1.0',
            minBalance: 2000000000000000000n,
            formattedMinBalance: '2.0',
            desiredBalance: 5000000000000000000n,
            formattedDesiredBalance: '5.0',
            needsFunding: true,
            deficit: 4000000000000000000n,
            formattedDeficit: '4.0',
          },
        ],
      },
    };

    metrics.recordBalances(reports);
    const metricsStr = await metrics.registry.metrics();

    expect(metricsStr).to.include('keyfunder_balance_gauge');
    expect(metricsStr).to.include('address="0xFunder"');
    expect(metricsStr).to.include('address="0xRec1"');
  });

  it('should record funding action counters and amounts', async () => {
    const actions: FundingAction[] = [
      {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0xRec1',
        currentBalance: 0n,
        formattedCurrentBalance: '0',
        minThreshold: 0n,
        formattedMinThreshold: '0',
        desiredBalance: 100n,
        formattedDesiredBalance: '100',
        requiredFunding: 2000000000000000000n,
        formattedRequiredFunding: '2.0',
        funderAddress: '0xFunder',
        funderBalance: 1000n,
        formattedFunderBalance: '1000',
        strategy: 'direct',
        status: 'EXECUTED',
        decimals: 18,
        symbol: 'ETH',
      },
      {
        chain: 'ethereum',
        protocol: 'ethereum',
        recipient: '0xRec2',
        currentBalance: 100n,
        formattedCurrentBalance: '100',
        minThreshold: 100n,
        formattedMinThreshold: '100',
        desiredBalance: 100n,
        formattedDesiredBalance: '100',
        requiredFunding: 0n,
        formattedRequiredFunding: '0',
        funderAddress: '0xFunder',
        funderBalance: 1000n,
        formattedFunderBalance: '1000',
        strategy: 'direct',
        status: 'SKIPPED',
        decimals: 18,
        symbol: 'ETH',
      },
    ];

    metrics.recordActions(actions);
    const metricsStr = await metrics.registry.metrics();

    expect(metricsStr).to.include('keyfunder_funding_actions_total');
    expect(metricsStr).to.include('status="executed"');
    expect(metricsStr).to.include('status="skipped"');
    expect(metricsStr).to.include('keyfunder_funding_amount_total');
  });

  it('should start and stop HTTP metrics server', async () => {
    const server = await metrics.startServer(9199);
    expect(server).to.not.be.undefined;

    const res = await fetch('http://localhost:9199/healthz');
    expect(res.status).to.equal(200);
    const data: any = await res.json();
    expect(data.status).to.equal('ok');

    const metricsRes = await fetch('http://localhost:9199/metrics');
    expect(metricsRes.status).to.equal(200);
    const metricsBody = await metricsRes.text();
    expect(metricsBody).to.include('keyfunder_balance_gauge');

    await metrics.stopServer();
  });
});
