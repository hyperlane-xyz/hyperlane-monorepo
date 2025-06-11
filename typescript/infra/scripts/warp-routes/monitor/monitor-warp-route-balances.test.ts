// Test suite for monitor-warp-route-balances.ts
// Uses Mocha for the test framework, Chai for assertions, and Sinon for mocking/spying.

import sinon from 'sinon';
import { expect } from 'chai';
// @ts-ignore
import AWS from 'aws-sdk';
const { CloudWatch } = AWS;
// @ts-ignore
const monitorModule: any = require('./monitor-warp-route-balances.js');

interface BalanceData {
  routeId: string;
  balance: string;
}

function mockBalanceData(balances: BalanceData[]): BalanceData[] {
  return balances;
}

describe('monitorWarpRouteBalances', () => {
  let cwPutMetricStub: any;

  beforeEach(() => {
    cwPutMetricStub = sinon
      .stub(CloudWatch.prototype, 'putMetricData')
      .returns({ promise: () => Promise.resolve({}) } as any);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('reports each warp-route balance to CloudWatch successfully', async () => {
    const mockBalances = mockBalanceData([
      { routeId: 'ETH/USDC', balance: '1000000000000000000' },
      { routeId: 'ETH/DAI', balance: '500000000000000000' },
    ]);
    sinon.stub(monitorModule, 'getWarpRouteBalances').resolves(mockBalances);
    await monitorModule.monitorWarpRouteBalances();
    expect(cwPutMetricStub.callCount).to.equal(mockBalances.length);
    expect(cwPutMetricStub.firstCall.args[0].MetricData[0].MetricName).to.equal('warp-route-balance');
  });

  it('does not call CloudWatch when no routes are returned and exits with 0', async () => {
    const exitStub = sinon.stub(process, 'exit');
    sinon.stub(monitorModule, 'getWarpRouteBalances').resolves(mockBalanceData([]));
    await monitorModule.monitorWarpRouteBalances();
    expect(cwPutMetricStub.called).to.be.false;
    expect(exitStub.calledOnceWithExactly(0)).to.be.true;
  });

  it('reports a zero balance to CloudWatch', async () => {
    const mockBalances = mockBalanceData([{ routeId: 'ETH/USDC', balance: '0' }]);
    sinon.stub(monitorModule, 'getWarpRouteBalances').resolves(mockBalances);
    await monitorModule.monitorWarpRouteBalances();
    expect(cwPutMetricStub.callCount).to.equal(1);
    const value = cwPutMetricStub.firstCall.args[0].MetricData[0].Value;
    expect(value).to.equal(0);
  });

  it('handles extremely large balances without overflow', async () => {
    const largeValue = Number.MAX_SAFE_INTEGER.toString();
    const mockBalances = mockBalanceData([{ routeId: 'LARGE/TEST', balance: largeValue }]);
    sinon.stub(monitorModule, 'getWarpRouteBalances').resolves(mockBalances);
    await monitorModule.monitorWarpRouteBalances();
    const value = cwPutMetricStub.firstCall.args[0].MetricData[0].Value;
    expect(value).to.equal(Number.MAX_SAFE_INTEGER);
  });

  it('propagates errors from AWS putMetricData', async () => {
    sinon.restore();
    cwPutMetricStub = sinon
      .stub(CloudWatch.prototype, 'putMetricData')
      .returns({ promise: () => Promise.reject(new Error('AWS failure')) } as any);
    sinon.stub(monitorModule, 'getWarpRouteBalances').resolves(
      mockBalanceData([{ routeId: 'X/TEST', balance: '1' }])
    );

    let caughtError: Error | undefined;
    try {
      await monitorModule.monitorWarpRouteBalances();
    } catch (err) {
      caughtError = err as Error;
    }
    expect(caughtError).to.be.instanceOf(Error);
    expect(caughtError!.message).to.equal('AWS failure');
  });

  it('logs and exits on balance fetch JSON errors', async () => {
    const jsonError = new SyntaxError('Unexpected token');
    sinon.stub(monitorModule, 'getWarpRouteBalances').rejects(jsonError);
    const consoleErrorStub = sinon.stub(console, 'error');
    const exitStub = sinon.stub(process, 'exit');

    await monitorModule.monitorWarpRouteBalances();
    expect(consoleErrorStub.calledOnceWithExactly(jsonError)).to.be.true;
    expect(exitStub.calledOnceWithExactly(1)).to.be.true;
  });
});