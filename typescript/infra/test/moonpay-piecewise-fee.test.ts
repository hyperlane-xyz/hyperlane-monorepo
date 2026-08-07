import { expect } from 'chai';
import { fileURLToPath } from 'url';

import { OnchainTokenFeeType } from '@hyperlane-xyz/sdk';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import {
  type LaneOnchainReader,
  type PiecewiseLaneConfig,
  type PiecewiseLaneSlot,
  type PreparedLaneUpdate,
  deduplicatePreparedUpdates,
  discoverPiecewiseLane,
  parsePiecewisePublisherConfig,
  prepareLaneUpdate,
  runPublisherUpdates,
  selectPublisherLanes,
} from '../scripts/moonpay/piecewise-fee-lib.js';

const SOURCE_ROUTER = '0x1111111111111111111111111111111111111111';
const TARGET_ROUTER = '0x2222222222222222222222222222222222222222';
const ROOT_FEE = '0x3333333333333333333333333333333333333333';
const PIECEWISE_FEE = '0x4444444444444444444444444444444444444444';
const FEE_TOKEN = '0x5555555555555555555555555555555555555555';

function rawLane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bsc-usdt-arbitrum-usdc',
    origin: 'bsc',
    sourceRouteId: 'USDT/moonpay-staging',
    destination: 'arbitrum',
    targetRouteId: 'USDC/moonpay-staging',
    standing: {
      breakpoints: ['0.25', '0.75'],
      marginalBps: [2, 6, 12],
      ttl: '60s',
      staleAfter: '12s',
      staleMarginalSurchargeBps: [2, 4, 8],
    },
    fallback: {
      breakpoints: ['0.25', '0.75'],
      marginalBps: [4, 10, 20],
    },
    ...overrides,
  };
}

function parsedLane(): PiecewiseLaneConfig {
  return parsePiecewisePublisherConfig({
    version: 2,
    lanes: [rawLane()],
  }).lanes[0];
}

function mockReader(options: { leafType?: number } = {}) {
  const explicitCalls: unknown[][] = [];
  const reader: LaneOnchainReader = {
    getDomainId: () => 42161,
    getFeeRecipient: async () => ROOT_FEE,
    getFeeType: async (_origin, address) =>
      address === ROOT_FEE
        ? OnchainTokenFeeType.CrossCollateralRoutingFee
        : (options.leafType ??
          OnchainTokenFeeType.OffchainQuotedPiecewiseLinearFee),
    getExplicitFeeContract: async (...args) => {
      explicitCalls.push(args);
      return PIECEWISE_FEE;
    },
    getPiecewiseMetadata: async () => ({
      feeToken: FEE_TOKEN,
      maxBands: 4,
      tokenDecimals: 18,
    }),
  };
  return { reader, explicitCalls };
}

function mockRegistry(
  targetTokens = [
    {
      chainName: 'arbitrum',
      addressOrDenom: TARGET_ROUTER,
      symbol: 'USDC',
    },
  ],
) {
  const requested: string[] = [];
  return {
    requested,
    registry: {
      getWarpRoute: async (routeId: string) => {
        requested.push(routeId);
        if (routeId === 'USDT/moonpay-staging') {
          return {
            tokens: [
              {
                chainName: 'bsc',
                addressOrDenom: SOURCE_ROUTER,
                symbol: 'USDT',
              },
              { chainName: 'ethereum', addressOrDenom: FEE_TOKEN },
            ],
          };
        }
        if (routeId === 'USDC/moonpay-staging') {
          return { tokens: targetTokens };
        }
        return undefined;
      },
    },
  };
}

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
    routingFeeAddress: ROOT_FEE,
    piecewiseFeeAddress: PIECEWISE_FEE,
    feeToken: FEE_TOKEN,
    tokenDecimals: 18,
    maxBands: 4,
    ...overrides,
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('Expected promise to reject');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('Moonpay lane-addressed piecewise fee publisher', () => {
  it('loads the single checked-in staging lane and exact fixture values', () => {
    const config = parsePiecewisePublisherConfig(
      readYaml(
        fileURLToPath(
          new URL(
            '../config/environments/mainnet3/warp/fees/moonpay-staging-piecewise.yaml',
            import.meta.url,
          ),
        ),
      ),
    );
    expect(config.version).to.equal(2);
    expect(config.lanes).to.have.length(1);
    expect(config.lanes[0]).to.deep.equal({
      id: 'bsc-usdt-arbitrum-usdc',
      origin: 'bsc',
      sourceRouteId: 'USDT/moonpay-staging',
      destination: 'arbitrum',
      targetRouteId: 'USDC/moonpay-staging',
      standing: {
        breakpoints: ['0.25', '0.75'],
        marginalBps: [2, 6, 12],
        ttlSeconds: 60,
        staleAfterSeconds: 12,
        staleMarginalSurchargeBps: [2, 4, 8],
      },
      fallback: {
        breakpoints: ['0.25', '0.75'],
        marginalBps: [4, 10, 20],
      },
    });
  });

  it('rejects duplicate lane ids and requires a fallback', () => {
    expect(() =>
      parsePiecewisePublisherConfig({
        version: 2,
        lanes: [rawLane(), rawLane()],
      }),
    ).to.throw('Duplicate lane id');
    expect(() =>
      parsePiecewisePublisherConfig({
        version: 2,
        lanes: [rawLane({ fallback: undefined })],
      }),
    ).to.throw('fallback is required');
  });

  it('deduplicates repeated selectors and rejects absent lane or mode', () => {
    const lane = parsedLane();
    const config = { version: 2 as const, lanes: [lane] };
    expect(
      selectPublisherLanes(config, [lane.id, lane.id], 'fallback'),
    ).to.deep.equal([lane]);
    expect(() =>
      selectPublisherLanes(config, ['missing'], 'fallback'),
    ).to.throw('absent from config');
    expect(() =>
      selectPublisherLanes(
        { version: 2, lanes: [{ ...lane, standing: undefined }] },
        undefined,
        'standing',
      ),
    ).to.throw('has no standing curve');
  });

  it('resolves only the configured source router and explicit target router', async () => {
    const lane = parsedLane();
    const { registry, requested } = mockRegistry();
    const { reader, explicitCalls } = mockReader();
    const discovered = await discoverPiecewiseLane(registry, reader, lane);

    expect(requested.sort()).to.deep.equal(
      ['USDC/moonpay-staging', 'USDT/moonpay-staging'].sort(),
    );
    expect(explicitCalls).to.deep.equal([
      ['bsc', ROOT_FEE, 42161, TARGET_ROUTER],
    ]);
    expect(discovered).to.include({
      sourceRouter: SOURCE_ROUTER,
      targetRouter: TARGET_ROUTER,
      piecewiseFeeAddress: PIECEWISE_FEE,
    });
  });

  it('rejects a missing target router and a wrong explicit leaf type', async () => {
    const lane = parsedLane();
    const missingTarget = mockRegistry([]);
    expect(
      await rejectionMessage(
        discoverPiecewiseLane(
          missingTarget.registry,
          mockReader().reader,
          lane,
        ),
      ),
    ).to.include('target route must contain exactly one token');

    expect(
      await rejectionMessage(
        discoverPiecewiseLane(
          mockRegistry().registry,
          mockReader({ leafType: OnchainTokenFeeType.LinearFee }).reader,
          lane,
        ),
      ),
    ).to.include('explicit fee leaf is not');
  });

  it('materializes human units with the resolved fee-token decimals', () => {
    const update = prepareLaneUpdate(parsedLane(), slot(), 'standing');
    expect(update.curve.breakpoints).to.deep.equal([
      250_000_000_000_000_000n,
      750_000_000_000_000_000n,
    ]);
    expect(update.curve.marginalBpsX1e4).to.deep.equal([
      20_000, 60_000, 120_000,
    ]);
  });

  it('deduplicates identical update targets and rejects conflicting curves', () => {
    const first = prepareLaneUpdate(parsedLane(), slot(), 'fallback');
    if (first.mode !== 'fallback') throw new Error('Expected fallback update');
    const second: PreparedLaneUpdate = {
      ...first,
      laneIds: ['second-lane'],
      slot: { ...first.slot, laneId: 'second-lane' },
    };
    const deduped = deduplicatePreparedUpdates([first, second]);
    expect(deduped).to.have.length(1);
    expect(deduped[0].laneIds).to.deep.equal([
      'bsc-usdt-arbitrum-usdc',
      'second-lane',
    ]);
    const conflicting: PreparedLaneUpdate = {
      ...second,
      curve: { ...second.curve, marginalBpsX1e4: [50_000, 100_000, 200_000] },
    };
    expect(() => deduplicatePreparedUpdates([first, conflicting])).to.throw(
      'conflicting updates',
    );
  });

  it('defaults to dry-run and never invokes the submit callback', async () => {
    const lines: string[] = [];
    let submitCalls = 0;
    const update = prepareLaneUpdate(parsedLane(), slot(), 'standing');
    const results = await runPublisherUpdates({
      updates: [update],
      submit: false,
      submitterLabel: '<resolved on submit>',
      getTimestamp: async () => 1_000,
      submitUpdate: async () => {
        submitCalls += 1;
        return { status: 'unchanged' };
      },
      log: (line) => lines.push(line),
    });
    expect(results).to.deep.equal([]);
    expect(submitCalls).to.equal(0);
    expect(lines.join('\n')).to.include('DRY RUN');
    expect(lines.join('\n')).to.include('staleAt=1012 expiry=1060');
    expect(lines.join('\n')).to.include('Dry run complete');
  });
});
