import { expect } from 'chai';

import {
  DEFAULT_ROUTER_KEY,
  HypTokenRouterConfig,
  TokenFeeConfigInput,
  TokenFeeType,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  STAGING_ARBITRUM_USDC_ROUTER,
  STAGING_BSC_USDT_ROUTER,
  STAGING_FEE_DESTINATIONS,
  StagingFeeDeploymentPlan,
  buildStagingFeeDeploymentPlan,
  runStagingFeeDeployment,
} from '../scripts/moonpay/deploy-staging-piecewise-fee-lib.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function routeConfig(): Record<string, HypTokenRouterConfig> {
  const defaultFee = (): TokenFeeConfigInput => ({
    type: TokenFeeType.OffchainQuotedLinearFee,
    owner: address(1),
    bps: 3,
    quoteSigners: [address(2)],
  });
  const feeContracts: Record<
    string,
    Record<string, TokenFeeConfigInput>
  > = Object.fromEntries(
    STAGING_FEE_DESTINATIONS.map((destination) => [
      destination,
      { [DEFAULT_ROUTER_KEY]: defaultFee() },
    ]),
  );
  feeContracts.arbitrum[addressToBytes32(STAGING_ARBITRUM_USDC_ROUTER)] = {
    type: TokenFeeType.OffchainQuotedPiecewiseLinearFee,
    owner: address(1),
    maxBands: 4,
    quoteSigners: [address(2)],
    initialFallback: {
      breakpoints: [100_000n, 250_000n],
      marginalBps: [4, 10, 20],
    },
  };

  const config = {
    type: TokenType.crossCollateral,
    token: address(3),
    mailbox: address(4),
    owner: address(1),
    tokenFee: {
      type: TokenFeeType.CrossCollateralRoutingFee,
      owner: address(1),
      feeContracts,
    },
  } satisfies HypTokenRouterConfig;
  return { bsc: config };
}

describe('Moonpay staging piecewise fee deployment', () => {
  it('defaults to a structurally zero-write dry run', async () => {
    const plan = buildStagingFeeDeploymentPlan(routeConfig());
    let applyCalls = 0;

    const result = await runStagingFeeDeployment(
      {},
      {
        loadPlan: async () => plan,
        applyPlan: async () => {
          applyCalls += 1;
          return {};
        },
      },
    );

    expect(result.mode).to.equal('dry-run');
    expect(applyCalls).to.equal(0);
  });

  it('targets only BSC and accounts for one root, eight defaults, and one piecewise leaf', () => {
    const plan = buildStagingFeeDeploymentPlan(routeConfig());

    expect(plan.originChain).to.equal('bsc');
    expect(plan.router).to.equal(STAGING_BSC_USDT_ROUTER);
    expect(plan.destinationChains).to.have.members([
      ...STAGING_FEE_DESTINATIONS,
    ]);
    expect(plan.defaultLeafCount).to.equal(8);
    expect(plan.piecewiseLeafCount).to.equal(1);
    expect(plan.contractDeploymentCount).to.equal(10);
  });

  it('rejects a deployment config that adds any other fee-bearing origin', () => {
    const config = routeConfig();
    config.arbitrum = {
      ...config.bsc,
      tokenFee: config.bsc.tokenFee,
    };

    expect(() => buildStagingFeeDeploymentPlan(config)).to.throw(
      'Expected BSC to be the only fee-bearing origin',
    );
  });

  it('never invokes apply without the explicit apply flag', async () => {
    const plan = buildStagingFeeDeploymentPlan(routeConfig());
    const dependencies = {
      loadPlan: async (): Promise<StagingFeeDeploymentPlan> => plan,
      applyPlan: async (): Promise<never> => {
        throw new Error('write path invoked');
      },
    };

    const result = await runStagingFeeDeployment({ fork: true }, dependencies);
    expect(result.mode).to.equal('dry-run');
  });
});
