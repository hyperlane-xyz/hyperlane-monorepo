import { expect } from 'chai';
import sinon from 'sinon';
import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { addressToBytes32, ProtocolType } from '@hyperlane-xyz/utils';

import { setRegistry, resetRegistry } from '../config/registry.js';
import { WarpRouteIds } from '../config/environments/mainnet3/warp/warpIds.js';
import {
  getMoonpayStagingRebalancers,
  getMoonpayStagingUsdcPeers,
  getMoonpayStagingUsdGPeers,
} from '../config/environments/mainnet3/warp/configGetters/moonpayStaging.js';
import { getUSDGRobinhoodMoonpayStagingWarpConfig } from '../config/environments/mainnet3/warp/configGetters/getUSDGRobinhoodMoonpayStagingWarpConfig.js';

describe('Moonpay USDG staging configuration', () => {
  const chains = {
    ethereum: 1,
    arbitrum: 42161,
    base: 8453,
    arc: 5042,
    robinhood: 4663,
  };
  const address = '0x1111111111111111111111111111111111111111';
  const oldEnv = process.env.STAGING_REBALANCER_ADDRESS;
  beforeEach(() => {
    process.env.STAGING_REBALANCER_ADDRESS = address;
    const registry = sinon.createStubInstance(FileSystemRegistry);
    registry.getChainMetadata.callsFake((chain) => ({
      name: chain,
      chainId: chains[chain as keyof typeof chains],
      domainId: chains[chain as keyof typeof chains],
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://unused.invalid' }],
    }));
    registry.getWarpRoute.callsFake((id) => ({
      tokens: (id === WarpRouteIds.USDGRobinhoodMoonpaySTAGING
        ? ['robinhood']
        : ['ethereum', 'arbitrum', 'base', 'arc', 'polygon', 'solanamainnet']
      ).map((chainName) => ({
        chainName,
        addressOrDenom: address,
        decimals: 6,
        standard: TokenStandard.EvmHypCollateral,
        symbol: chainName === 'robinhood' ? 'USDG' : 'USDC',
        name: 'staging',
      })),
    }));
    setRegistry(registry);
  });
  afterEach(() => {
    sinon.restore();
    resetRegistry();
    if (oldEnv === undefined) delete process.env.STAGING_REBALANCER_ADDRESS;
    else process.env.STAGING_REBALANCER_ADDRESS = oldEnv;
  });
  it('only enrolls the four focused USDC peers for USDG', async () => {
    expect(Object.keys(getMoonpayStagingUsdcPeers()).sort()).to.deep.equal([
      '1',
      '42161',
      '5042',
      '8453',
    ]);
    expect(getMoonpayStagingUsdGPeers()).to.deep.equal({
      4663: [addressToBytes32(address)],
    });
    const config = await getUSDGRobinhoodMoonpayStagingWarpConfig({
      robinhood: { mailbox: address },
    });
    expect(Object.keys(config)).to.deep.equal(['robinhood']);
    expect(config.robinhood).to.include({
      token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    });
    expect(config.robinhood).not.to.have.property('tokenFee');
    expect(config.robinhood)
      .to.have.property('allowedRebalancingBridges')
      .that.deep.equals({});
  });
  it('requires a dedicated staging signer', () => {
    expect(getMoonpayStagingRebalancers()).to.include(address);
    delete process.env.STAGING_REBALANCER_ADDRESS;
    expect(() => getMoonpayStagingRebalancers()).to.throw(
      'STAGING_REBALANCER_ADDRESS',
    );
    process.env.STAGING_REBALANCER_ADDRESS =
      '0x93240ad82ca750da33de564f8dce8ebeb5885822';
    expect(() => getMoonpayStagingRebalancers()).to.throw('production');
  });
});
