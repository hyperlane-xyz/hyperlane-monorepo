import { expect } from 'chai';
import { Gauge, Registry } from 'prom-client';

import {
  buildWarpRouteErrorMetricEntries,
  getCheckRouteErrorGaugeObj,
  warpRouteErrorGroupings,
  warpViolationGroupings,
} from '../scripts/check/check-utils.js';

interface Case {
  name: string;
  attemptedRouteIds: string[];
  failedRouteIds: string[];
  expected: { warpRouteId: string; value: 0 | 1 }[];
}

describe('buildWarpRouteErrorMetricEntries', () => {
  const cases: Case[] = [
    {
      name: 'reader error on one route, another passes',
      attemptedRouteIds: ['USDC/ethereum', 'USDT/ethereum'],
      failedRouteIds: ['USDC/ethereum'],
      expected: [
        { warpRouteId: 'USDC/ethereum', value: 1 },
        { warpRouteId: 'USDT/ethereum', value: 0 },
      ],
    },
    {
      name: 'config-load failure listed in attempted and failed, another passes',
      attemptedRouteIds: ['USDT/ethereum', 'DAI/base'],
      failedRouteIds: ['DAI/base'],
      expected: [
        { warpRouteId: 'USDT/ethereum', value: 0 },
        { warpRouteId: 'DAI/base', value: 1 },
      ],
    },
    {
      name: 'all routes pass',
      attemptedRouteIds: ['USDC/ethereum', 'USDT/ethereum'],
      failedRouteIds: [],
      expected: [
        { warpRouteId: 'USDC/ethereum', value: 0 },
        { warpRouteId: 'USDT/ethereum', value: 0 },
      ],
    },
    {
      name: 'duplicate failed id yields a single entry',
      attemptedRouteIds: ['USDC/ethereum', 'USDC/ethereum'],
      failedRouteIds: ['USDC/ethereum', 'USDC/ethereum'],
      expected: [{ warpRouteId: 'USDC/ethereum', value: 1 }],
    },
    {
      name: 'route with violations but no execution error is 0',
      attemptedRouteIds: ['USDC/ethereum'],
      failedRouteIds: [],
      expected: [{ warpRouteId: 'USDC/ethereum', value: 0 }],
    },
    {
      name: 'empty input',
      attemptedRouteIds: [],
      failedRouteIds: [],
      expected: [],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        buildWarpRouteErrorMetricEntries({
          attemptedRouteIds: c.attemptedRouteIds,
          failedRouteIds: c.failedRouteIds,
        }),
      ).to.deep.equal(c.expected);
    });
  }
});

describe('warpRouteErrorGroupings', () => {
  it('pins base64url route_key for an id containing "/"', () => {
    expect(warpRouteErrorGroupings('ethereum/usdc')).to.deep.equal({
      route_key: 'ZXRoZXJldW0vdXNkYw',
    });
  });

  it('uses route_key, not the violation alert_key', () => {
    const groupings = warpRouteErrorGroupings('ethereum/usdc');
    expect(Object.keys(groupings)).to.deep.equal(['route_key']);
    expect(
      Object.keys(warpViolationGroupings('ethereum/usdc', 'a', 'b', 'c')),
    ).to.deep.equal(['alert_key']);
  });
});

describe('getCheckRouteErrorGaugeObj', () => {
  it('exposes the route error series with module and warp_route_id labels', async () => {
    const register = new Registry();
    const gauge = new Gauge(getCheckRouteErrorGaugeObj(register));
    gauge.labels({ module: 'warp', warp_route_id: 'USDC/ethereum' }).set(1);

    const output = await register.metrics();
    expect(output).to.contain(
      'hyperlane_check_route_error{module="warp",warp_route_id="USDC/ethereum"} 1',
    );
  });
});
