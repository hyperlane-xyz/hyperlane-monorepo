import { expect } from 'chai';
import { fileURLToPath } from 'node:url';

import { OnchainTokenFeeType } from '@hyperlane-xyz/sdk';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import {
  type LaneOnchainReader,
  discoverPiecewiseLane,
  parsePiecewisePublisherConfig,
  selectPublisherLanes,
} from '../scripts/moonpay/piecewise-fee-lib.js';

const SOURCE_ROUTER = '0x1111111111111111111111111111111111111111';
const ROOT_FEE = '0x2222222222222222222222222222222222222222';
const PIECEWISE_FEE = '0x3333333333333333333333333333333333333333';
const FEE_TOKEN = '0x55d398326f99059fF775485246999027B3197955';
const SOLANA_TARGET = 'HW9NfLGo6YMoM6o5auTvn5h26tWJPpsroUDfGFwvsQsU';

describe('Moonpay production piecewise publisher template', () => {
  it('defines exactly the seven BSC USDT to remote USDC fallback lanes', () => {
    const config = parsePiecewisePublisherConfig(
      readYaml(
        fileURLToPath(
          new URL(
            '../config/environments/mainnet3/warp/fees/moonpay-production-piecewise.yaml',
            import.meta.url,
          ),
        ),
      ),
    );

    expect(config.lanes.map(({ destination }) => destination)).to.deep.equal([
      'arbitrum',
      'base',
      'citrea',
      'ethereum',
      'katana',
      'polygon',
      'solanamainnet',
    ]);
    expect(config.lanes).to.have.length(7);
    for (const lane of config.lanes) {
      expect(lane.origin).to.equal('bsc');
      expect(lane.sourceRouteId).to.equal('USDT/moonpay');
      expect(lane.targetRouteId).to.equal('USDC/moonpay');
      expect(lane.standing).to.equal(undefined);
      expect(lane.fallback).to.deep.equal({
        breakpoints: [],
        marginalBps: [15],
      });
    }
    expect(selectPublisherLanes(config, undefined, 'fallback')).to.have.length(
      7,
    );
    expect(() => selectPublisherLanes(config, undefined, 'standing')).to.throw(
      'has no standing curve',
    );
  });

  it('accepts the Solana target router while retaining an EVM source router', async () => {
    const config = parsePiecewisePublisherConfig(
      readYaml(
        fileURLToPath(
          new URL(
            '../config/environments/mainnet3/warp/fees/moonpay-production-piecewise.yaml',
            import.meta.url,
          ),
        ),
      ),
    );
    const lane = config.lanes.find(
      ({ destination }) => destination === 'solanamainnet',
    );
    expect(lane).not.to.equal(undefined);
    if (!lane) return;

    const explicitTargets: string[] = [];
    const reader: LaneOnchainReader = {
      getDomainId: () => 1_399_811_149,
      getFeeRecipient: async () => ROOT_FEE,
      getFeeType: async (_origin, address) =>
        address === ROOT_FEE
          ? OnchainTokenFeeType.CrossCollateralRoutingFee
          : OnchainTokenFeeType.OffchainQuotedPiecewiseLinearFee,
      getExplicitFeeContract: async (_origin, _root, _destination, target) => {
        explicitTargets.push(target);
        return PIECEWISE_FEE;
      },
      getPiecewiseMetadata: async () => ({
        feeToken: FEE_TOKEN,
        maxBands: 4,
        tokenDecimals: 18,
      }),
    };
    const registry = {
      getWarpRoute: async (routeId: string) =>
        routeId === 'USDT/moonpay'
          ? {
              tokens: [
                {
                  chainName: 'bsc',
                  addressOrDenom: SOURCE_ROUTER,
                  symbol: 'USDT',
                },
              ],
            }
          : {
              tokens: [
                {
                  chainName: 'solanamainnet',
                  addressOrDenom: SOLANA_TARGET,
                  symbol: 'USDC',
                },
              ],
            },
    };

    const slot = await discoverPiecewiseLane(registry, reader, lane);
    expect(slot.sourceRouter).to.equal(SOURCE_ROUTER);
    expect(slot.targetRouter).to.equal(SOLANA_TARGET);
    expect(explicitTargets).to.deep.equal([SOLANA_TARGET]);
  });
});
