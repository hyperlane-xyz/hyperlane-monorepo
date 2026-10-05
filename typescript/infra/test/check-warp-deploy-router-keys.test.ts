import { expect } from 'chai';

import {
  MultiProvider,
  TestChainName,
  TokenType,
  type DestinationGas,
  type MovableTokenConfig,
  type RemoteRouters,
  type WarpRouteDeployConfigMailboxRequired,
  isMovableCollateralTokenConfig,
  test1,
  test2,
  test3,
} from '@hyperlane-xyz/sdk';

import { resolveWarpDeployConfigRouterKeys } from '../scripts/check/check-utils.js';

const owner = '0x1111111111111111111111111111111111111111';
const mailbox = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const router = '0x4444444444444444444444444444444444444444';
const bridge = '0x5555555555555555555555555555555555555555';

interface RouterKeyOverrides {
  destinationGas?: DestinationGas;
  remoteRouters?: RemoteRouters;
  allowedRebalancingBridges?: MovableTokenConfig['allowedRebalancingBridges'];
}

describe('resolveWarpDeployConfigRouterKeys', () => {
  const multiProvider = new MultiProvider({
    [TestChainName.test1]: test1,
    [TestChainName.test2]: test2,
    [TestChainName.test3]: test3,
  });

  function config(
    chainConfig: WarpRouteDeployConfigMailboxRequired[string],
  ): WarpRouteDeployConfigMailboxRequired {
    return {
      [TestChainName.test1]: chainConfig,
    };
  }

  function collateralConfig(
    overrides: RouterKeyOverrides = {},
  ): WarpRouteDeployConfigMailboxRequired[string] {
    return {
      type: TokenType.collateral,
      owner,
      mailbox,
      token,
      ...overrides,
    };
  }

  it('resolves chain name keys to domain ids', () => {
    const warpDeployConfig = config(
      collateralConfig({
        destinationGas: {
          [TestChainName.test2]: '123',
        },
        remoteRouters: {
          [TestChainName.test2]: { address: router },
        },
        allowedRebalancingBridges: {
          [TestChainName.test2]: [{ bridge }],
        },
      }),
    );

    const resolved = resolveWarpDeployConfigRouterKeys(
      multiProvider,
      warpDeployConfig,
    );

    expect(resolved[TestChainName.test1].destinationGas).to.deep.equal({
      [test2.domainId]: '123',
    });
    expect(resolved[TestChainName.test1].remoteRouters).to.deep.equal({
      [test2.domainId]: { address: router },
    });
    const resolvedChainConfig = resolved[TestChainName.test1];
    if (!isMovableCollateralTokenConfig(resolvedChainConfig)) {
      throw new Error('Expected movable collateral config');
    }
    expect(resolvedChainConfig.allowedRebalancingBridges).to.deep.equal({
      [test2.domainId]: [{ bridge }],
    });
  });

  it('preserves numeric keys', () => {
    const warpDeployConfig = config(
      collateralConfig({
        destinationGas: {
          [test2.domainId]: '123',
        },
      }),
    );

    const resolved = resolveWarpDeployConfigRouterKeys(
      multiProvider,
      warpDeployConfig,
    );

    expect(resolved[TestChainName.test1].destinationGas).to.deep.equal({
      [test2.domainId]: '123',
    });
  });

  it('resolves mixed chain name and numeric keys', () => {
    const warpDeployConfig = config(
      collateralConfig({
        destinationGas: {
          [TestChainName.test2]: '123',
          [test3.domainId]: '456',
        },
      }),
    );

    const resolved = resolveWarpDeployConfigRouterKeys(
      multiProvider,
      warpDeployConfig,
    );

    expect(resolved[TestChainName.test1].destinationGas).to.deep.equal({
      [test2.domainId]: '123',
      [test3.domainId]: '456',
    });
  });

  it('does not mutate the input config', () => {
    const warpDeployConfig = config(
      collateralConfig({
        destinationGas: {
          [TestChainName.test2]: '123',
        },
        remoteRouters: {
          [TestChainName.test2]: { address: router },
        },
        allowedRebalancingBridges: {
          [TestChainName.test2]: [{ bridge }],
        },
      }),
    );
    const original = structuredClone(warpDeployConfig);

    const resolved = resolveWarpDeployConfigRouterKeys(
      multiProvider,
      warpDeployConfig,
    );

    expect(warpDeployConfig).to.deep.equal(original);
    expect(resolved).not.to.equal(warpDeployConfig);
    expect(resolved[TestChainName.test1]).not.to.equal(
      warpDeployConfig[TestChainName.test1],
    );
  });

  it('throws for unknown chain name keys', () => {
    const warpDeployConfig = config(
      collateralConfig({
        destinationGas: {
          unknownchain: '123',
        },
      }),
    );

    expect(() =>
      resolveWarpDeployConfigRouterKeys(multiProvider, warpDeployConfig),
    ).to.throw('No chain metadata set for unknownchain');
  });
});
