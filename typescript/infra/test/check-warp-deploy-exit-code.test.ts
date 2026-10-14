import { expect } from 'chai';

import {
  allAttemptedRoutesFailed,
  getCheckWarpDeployExitCode,
} from '../scripts/check/check-utils.js';

interface Case {
  name: string;
  attemptedRoutes: number;
  failedRoutes: number;
  failedMetricPublications?: number;
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
    {
      name: 'exits 1 when metric publication failed but routes passed',
      attemptedRoutes: 5,
      failedRoutes: 0,
      failedMetricPublications: 1,
      expected: 1,
    },
    {
      name: 'exits 1 when metric publication failed and some routes failed',
      attemptedRoutes: 5,
      failedRoutes: 2,
      failedMetricPublications: 3,
      expected: 1,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        getCheckWarpDeployExitCode({
          attemptedRoutes: c.attemptedRoutes,
          failedRoutes: c.failedRoutes,
          failedMetricPublications: c.failedMetricPublications ?? 0,
        }),
      ).to.equal(c.expected);
    });
  }
});

describe('allAttemptedRoutesFailed', () => {
  interface PredicateCase {
    name: string;
    attemptedRoutes: number;
    failedRoutes: number;
    expected: boolean;
  }

  const cases: PredicateCase[] = [
    {
      name: 'false when no route was attempted',
      attemptedRoutes: 0,
      failedRoutes: 0,
      expected: false,
    },
    {
      name: 'true when every attempted route failed',
      attemptedRoutes: 5,
      failedRoutes: 5,
      expected: true,
    },
    {
      name: 'false when only some routes failed',
      attemptedRoutes: 5,
      failedRoutes: 4,
      expected: false,
    },
    {
      name: 'false when no route failed',
      attemptedRoutes: 5,
      failedRoutes: 0,
      expected: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        allAttemptedRoutesFailed({
          attemptedRoutes: c.attemptedRoutes,
          failedRoutes: c.failedRoutes,
        }),
      ).to.equal(c.expected);
    });
  }
});
