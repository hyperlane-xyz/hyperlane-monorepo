import { expect } from 'chai';

import type {
  LaneRegistry,
  MaterializedCurve,
  MaterializedStandingCurve,
  PiecewiseLaneSlot,
} from '../scripts/moonpay/piecewise-fee-lib.js';
import {
  type LifecycleDependencies,
  type LifecyclePhase,
  type LifecycleQuote,
  type StandingTiming,
  STAGING_TOKEN_ALLOWANCE_CAP,
  STAGING_TRANSFER_AMOUNT,
  assertExactRouterConfirmations,
  assertStagingLifecycleLane,
  computePiecewiseFee,
  pollForBlockTimestamp,
  runStagingLifecycle,
  withStagingLifecycleRoutes,
} from '../scripts/moonpay/piecewise-fee-lifecycle-lib.js';

const SOURCE_ROUTER = '0x1111111111111111111111111111111111111111';
const TARGET_ROUTER = '0x2222222222222222222222222222222222222222';

function slot(overrides: Partial<PiecewiseLaneSlot> = {}): PiecewiseLaneSlot {
  return {
    laneId: 'bsc-usdt-arbitrum-usdc',
    origin: 'bsc',
    sourceRouteId: 'USDT/moonpay-staging',
    sourceRouter: SOURCE_ROUTER,
    sourceToken: 'USDT',
    destination: 'arbitrum',
    destDomain: 42161,
    targetRouteId: 'USDC/moonpay-staging',
    targetRouter: TARGET_ROUTER,
    routingFeeAddress: '0x3333333333333333333333333333333333333333',
    piecewiseFeeAddress: '0x4444444444444444444444444444444444444444',
    feeToken: '0x5555555555555555555555555555555555555555',
    tokenDecimals: 18,
    maxBands: 4,
    ...overrides,
  };
}

const fallbackCurve: MaterializedCurve = {
  breakpoints: [100_000n * 10n ** 18n, 250_000n * 10n ** 18n],
  marginalBpsX1e4: [40_000, 100_000, 200_000],
};

const standingCurve: MaterializedStandingCurve = {
  breakpoints: fallbackCurve.breakpoints,
  marginalBpsX1e4: [20_000, 60_000, 120_000],
  staleMarginalSurchargeBpsX1e4: [20_000, 40_000, 80_000],
  staleAfterSeconds: 12,
  ttlSeconds: 60,
};

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function lifecycleDependencies(options: {
  currentTimestamp?: number;
  currentTiming?: StandingTiming;
  quoteFees?: bigint[];
  transferBalanceDelta?: (fee: bigint) => bigint;
}) {
  const calls = {
    begin: 0,
    end: 0,
    publish: 0,
    quote: 0,
    transfer: [] as LifecyclePhase[],
    waits: [] as number[],
    verify: 0,
  };
  const fallbackFee = computePiecewiseFee(
    fallbackCurve,
    STAGING_TRANSFER_AMOUNT,
  );
  const freshFee = computePiecewiseFee(standingCurve, STAGING_TRANSFER_AMOUNT);
  const quoteFees = options.quoteFees ?? [
    fallbackFee,
    fallbackFee,
    freshFee,
    fallbackFee,
    fallbackFee,
  ];
  let rootBalance = 1_000n;
  const publishedTiming = {
    issuedAt: 300,
    staleAfterSeconds: 12,
    expiry: 360,
  };
  const transferTimestamps: Record<LifecyclePhase, number> = {
    fallback: 201,
    fresh: 305,
    stale: 313,
    expired: 361,
  };
  const dependencies: LifecycleDependencies = {
    getBlockTimestamp: async () => options.currentTimestamp ?? 200,
    getStandingTiming: async () =>
      options.currentTiming ?? {
        issuedAt: 0,
        staleAfterSeconds: 0,
        expiry: 0,
      },
    verifyFallback: async () => {
      calls.verify += 1;
    },
    quote: async (): Promise<LifecycleQuote> => {
      const piecewiseFee = quoteFees[calls.quote] ?? fallbackFee;
      calls.quote += 1;
      return {
        piecewiseFee,
        feeRootBalance: rootBalance,
        tokenDebit: STAGING_TRANSFER_AMOUNT + piecewiseFee,
        nativeValue: 0n,
        raw: {},
      };
    },
    waitUntilBlockTimestamp: async (target) => {
      calls.waits.push(target);
      return target;
    },
    beginTransfers: async () => {
      calls.begin += 1;
    },
    publishStanding: async () => {
      calls.publish += 1;
      return publishedTiming;
    },
    transfer: async (phase, quote) => {
      calls.transfer.push(phase);
      rootBalance +=
        options.transferBalanceDelta?.(quote.piecewiseFee) ??
        quote.piecewiseFee;
      return {
        txHash: `0x${phase}`,
        feeRootBalance: rootBalance,
        blockTimestamp: transferTimestamps[phase],
      };
    },
    endTransfers: async () => {
      calls.end += 1;
    },
  };
  return { calls, dependencies, fallbackFee, freshFee };
}

describe('Moonpay piecewise staging lifecycle', () => {
  it('supplies exact private staging routes without relying on registry records', async () => {
    const delegated: string[] = [];
    const baseRegistry: LaneRegistry = {
      getWarpRoute: async (routeId) => {
        delegated.push(routeId);
        return { tokens: [] };
      },
    };
    const registry = withStagingLifecycleRoutes(
      baseRegistry,
      SOURCE_ROUTER,
      TARGET_ROUTER,
    );

    expect(await registry.getWarpRoute('USDT/moonpay-staging')).to.deep.equal({
      tokens: [
        {
          chainName: 'bsc',
          addressOrDenom: SOURCE_ROUTER,
          symbol: 'USDT',
        },
      ],
    });
    expect(await registry.getWarpRoute('USDC/moonpay-staging')).to.deep.equal({
      tokens: [
        {
          chainName: 'arbitrum',
          addressOrDenom: TARGET_ROUTER,
          symbol: 'USDC',
        },
      ],
    });
    await registry.getWarpRoute('unrelated/route');
    expect(delegated).to.deep.equal(['unrelated/route']);
  });

  it('locks the lifecycle to the exact lane, decimals, and router confirmations', () => {
    expect(() => assertStagingLifecycleLane(slot())).not.to.throw();
    expect(() =>
      assertStagingLifecycleLane(slot({ destination: 'ethereum' })),
    ).to.throw('locked to');
    expect(() =>
      assertStagingLifecycleLane(slot({ tokenDecimals: 6 })),
    ).to.throw('10e18');
    expect(() =>
      assertExactRouterConfirmations(slot(), SOURCE_ROUTER, TARGET_ROUTER),
    ).not.to.throw();
    expect(() =>
      assertExactRouterConfirmations(slot(), TARGET_ROUTER, TARGET_ROUTER),
    ).to.throw('confirm-source-router');
  });

  it('computes the same weighted fee across multiple marginal bands', () => {
    const curve: MaterializedCurve = {
      breakpoints: [100n, 200n],
      marginalBpsX1e4: [1_000_000, 2_000_000, 3_000_000],
    };
    expect(computePiecewiseFee(curve, 250n)).to.equal(4n);
    expect(
      computePiecewiseFee(fallbackCurve, STAGING_TRANSFER_AMOUNT),
    ).to.equal(4_000_000_000_000_000n);
  });

  it('polls block timestamps, not wall-clock time', async () => {
    const timestamps = [100, 104, 108];
    let sleeps = 0;
    const result = await pollForBlockTimestamp({
      target: 108,
      readTimestamp: async () => timestamps.shift() ?? 108,
      sleep: async () => {
        sleeps += 1;
      },
      intervalMs: 1,
      maxPolls: 4,
    });
    expect(result).to.equal(108);
    expect(sleeps).to.equal(2);
  });

  it('is read-only by default', async () => {
    const { calls, dependencies } = lifecycleDependencies({});
    const lines: string[] = [];
    const result = await runStagingLifecycle({
      submit: false,
      slot: slot(),
      fallbackCurve,
      standingCurve,
      dependencies,
      log: (line) => lines.push(line),
    });
    expect(result).to.deep.equal([]);
    expect(calls.verify).to.equal(1);
    expect(calls.quote).to.equal(1);
    expect(calls.begin).to.equal(0);
    expect(calls.publish).to.equal(0);
    expect(calls.transfer).to.deep.equal([]);
    expect(calls.waits).to.deep.equal([]);
    expect(calls.end).to.equal(0);
    expect(lines.join('\n')).to.include('DRY RUN');
    expect(lines.join('\n')).to.include('No approval');
  });

  it('runs fallback, fresh, stale, and expired with block-time gates', async () => {
    const { calls, dependencies, fallbackFee, freshFee } =
      lifecycleDependencies({});
    const result = await runStagingLifecycle({
      submit: true,
      slot: slot(),
      fallbackCurve,
      standingCurve,
      dependencies,
      log: () => undefined,
    });
    expect(result.map(({ phase }) => phase)).to.deep.equal([
      'fallback',
      'fresh',
      'stale',
      'expired',
    ]);
    expect(result.map(({ expectedFee }) => expectedFee)).to.deep.equal([
      fallbackFee,
      freshFee,
      fallbackFee,
      fallbackFee,
    ]);
    expect(calls.begin).to.equal(1);
    expect(calls.publish).to.equal(1);
    expect(calls.transfer).to.deep.equal([
      'fallback',
      'fresh',
      'stale',
      'expired',
    ]);
    expect(calls.waits).to.deep.equal([312, 361]);
    expect(calls.end).to.equal(1);
  });

  it('waits for an existing standing curve to expire before approval', async () => {
    const { calls, dependencies } = lifecycleDependencies({
      currentTimestamp: 100,
      currentTiming: { issuedAt: 50, staleAfterSeconds: 12, expiry: 105 },
    });
    await runStagingLifecycle({
      submit: true,
      slot: slot(),
      fallbackCurve,
      standingCurve,
      dependencies,
      log: () => undefined,
    });
    expect(calls.waits).to.deep.equal([106, 312, 361]);
    expect(calls.begin).to.equal(1);
  });

  it('fails closed on a wrong effective fee and still revokes allowance', async () => {
    const expectedFallback = computePiecewiseFee(
      fallbackCurve,
      STAGING_TRANSFER_AMOUNT,
    );
    const { calls, dependencies } = lifecycleDependencies({
      quoteFees: [expectedFallback, 1n],
    });
    expect(
      await rejectionMessage(
        runStagingLifecycle({
          submit: true,
          slot: slot(),
          fallbackCurve,
          standingCurve,
          dependencies,
          log: () => undefined,
        }),
      ),
    ).to.include('quote fee');
    expect(calls.transfer).to.deep.equal([]);
    expect(calls.end).to.equal(1);
  });

  it('fails closed on an unexpected fee-root balance delta', async () => {
    const { calls, dependencies } = lifecycleDependencies({
      transferBalanceDelta: (fee) => fee + 1n,
    });
    expect(
      await rejectionMessage(
        runStagingLifecycle({
          submit: true,
          slot: slot(),
          fallbackCurve,
          standingCurve,
          dependencies,
          log: () => undefined,
        }),
      ),
    ).to.include('fee-root balance delta');
    expect(calls.end).to.equal(1);
  });

  it('keeps the cumulative lifecycle token approval below 50e18', () => {
    expect(4n * STAGING_TRANSFER_AMOUNT < STAGING_TOKEN_ALLOWANCE_CAP).to.equal(
      true,
    );
  });
});
