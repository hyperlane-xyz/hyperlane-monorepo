import { expect } from 'chai';

import { getCheckWarpDeployExitCode } from '../scripts/check/check-utils.js';

interface Case {
  name: string;
  attemptedRoutes: number;
  failedRoutes: number;
  expected: 0 | 1;
}

describe('getCheckWarpDeployExitCode', () => {
  const cases: Case[] = [
    {
      name: 'exits 0 when no route failed',
      attemptedRoutes: 5,
      failedRoutes: 0,
      expected: 0,
    },
    {
      name: 'exits 0 when some routes failed but others were checked',
      attemptedRoutes: 5,
      failedRoutes: 4,
      expected: 0,
    },
    {
      name: 'exits 0 when a single route failed among many',
      attemptedRoutes: 50,
      failedRoutes: 1,
      expected: 0,
    },
    {
      name: 'exits 1 when every attempted route failed',
      attemptedRoutes: 5,
      failedRoutes: 5,
      expected: 1,
    },
    {
      name: 'exits 1 when the only attempted route failed',
      attemptedRoutes: 1,
      failedRoutes: 1,
      expected: 1,
    },
    {
      name: 'exits 0 when no route was attempted',
      attemptedRoutes: 0,
      failedRoutes: 0,
      expected: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        getCheckWarpDeployExitCode({
          attemptedRoutes: c.attemptedRoutes,
          failedRoutes: c.failedRoutes,
        }),
      ).to.equal(c.expected);
    });
  }
});
