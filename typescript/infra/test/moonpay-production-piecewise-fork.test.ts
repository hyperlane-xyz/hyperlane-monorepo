import { expect } from 'chai';

import {
  DEFAULT_ROUTER_KEY,
  HypTokenRouterConfig,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  PRODUCTION_BSC_EXISTING_FEE_ROOT,
  PRODUCTION_BSC_USDT_ROUTER,
  buildProductionPiecewiseForkPlan,
  runProductionPiecewiseFork,
} from '../scripts/moonpay/deploy-production-piecewise-fee-fork-lib.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const MAILBOX = '0x2222222222222222222222222222222222222222';

function fixtureConfig(): HypTokenRouterConfig {
  const destinations = [
    'arbitrum',
    'base',
    'citrea',
    'ethereum',
    'katana',
    'polygon',
    'solanamainnet',
  ];
  const linear = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedLinearFee,
    owner: OWNER,
    bps: 3,
    quoteSigners: [OWNER],
  });
  const piecewise = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    owner: OWNER,
    initialFallback: { breakpoints: [], marginalBps: [3] },
    maxBands: 4,
    quoteSigners: [OWNER],
  });

  return {
    type: TokenType.crossCollateral,
    token: '0x55d398326f99059fF775485246999027B3197955',
    mailbox: MAILBOX,
    owner: OWNER,
    tokenFee: {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: OWNER,
      feeContracts: Object.fromEntries(
        destinations.map((destination, index) => [
          destination,
          {
            [DEFAULT_ROUTER_KEY]: linear(),
            [`0x${(index + 1).toString(16).padStart(64, '0')}`]: piecewise(),
          },
        ]),
      ),
    },
  };
}

describe('Moonpay production piecewise fork harness', () => {
  it('plans seven distinct piecewise destinations against the guarded snapshot', () => {
    const plan = buildProductionPiecewiseForkPlan(fixtureConfig());
    expect(plan.router).to.equal(PRODUCTION_BSC_USDT_ROUTER);
    expect(plan.expectedFeeRoot).to.equal(PRODUCTION_BSC_EXISTING_FEE_ROOT);
    expect(plan.piecewiseLeafCount).to.equal(7);
    expect(plan.piecewiseDestinations).to.deep.equal([
      'arbitrum',
      'base',
      'citrea',
      'ethereum',
      'katana',
      'polygon',
      'solanamainnet',
    ]);
  });

  it('is structurally read-only by default', async () => {
    let applies = 0;
    const plan = buildProductionPiecewiseForkPlan(fixtureConfig());
    const result = await runProductionPiecewiseFork(
      {},
      {
        loadPlan: async () => plan,
        applyPlan: async () => {
          applies += 1;
          return {};
        },
      },
    );
    expect(result.mode).to.equal('dry-run');
    expect(applies).to.equal(0);
  });

  it('rejects every write path that is not an explicit local fork', async () => {
    const plan = buildProductionPiecewiseForkPlan(fixtureConfig());
    let message = '';
    try {
      await runProductionPiecewiseFork(
        { apply: true },
        { loadPlan: async () => plan, applyPlan: async () => ({}) },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.include('Production writes are forbidden');
  });
});
