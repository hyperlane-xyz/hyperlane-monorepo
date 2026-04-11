import { expect } from 'chai';

import {
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  defaultWarpFeeVaultName,
  defaultWarpFeeVaultSymbol,
  inferWarpFeeVaultDeployConfig,
} from './feeVault.js';

describe('inferWarpFeeVaultDeployConfig', () => {
  const hubRouter = '0x1111111111111111111111111111111111111111';
  const asset = '0x2222222222222222222222222222222222222222';
  const owner = '0x3333333333333333333333333333333333333333';
  const protocolBeneficiary = '0x4444444444444444444444444444444444444444';

  const warpCoreConfig: WarpCoreConfig = {
    tokens: [
      {
        chainName: 'ethereum',
        standard: TokenStandard.EvmHypCollateral,
        decimals: 18,
        symbol: 'USDC',
        name: 'USD Coin',
        addressOrDenom: hubRouter,
        collateralAddressOrDenom: asset,
      },
    ],
  };

  const warpDeployConfig = {
    ethereum: {
      type: TokenType.collateral,
      owner,
      token: asset,
    },
  } as any;

  const multiProvider = {
    getProtocol: () => ProtocolType.Ethereum,
  } as any;

  it('infers route-bound fields and derives defaults from route token metadata', async () => {
    const inferred = await inferWarpFeeVaultDeployConfig({
      chain: 'ethereum',
      multiProvider,
      warpCoreConfig,
      warpDeployConfig,
      owner,
      protocolBeneficiary,
      lpBps: '2500',
      streamingPeriod: '86400',
      readRouterAsset: async () => asset,
    });

    expect(inferred.hubRouter).to.equal(hubRouter);
    expect(inferred.routeTokenName).to.equal('USD Coin');
    expect(inferred.routeTokenSymbol).to.equal('USDC');
    expect(inferred.config).to.deep.equal({
      owner,
      asset,
      hubRouter,
      lpBps: '2500',
      protocolBeneficiary,
      streamingPeriod: '86400',
      name: defaultWarpFeeVaultName('USD Coin'),
      symbol: defaultWarpFeeVaultSymbol('USDC'),
    });
  });

  it('allows explicit name and symbol overrides', async () => {
    const inferred = await inferWarpFeeVaultDeployConfig({
      chain: 'ethereum',
      multiProvider,
      warpCoreConfig,
      warpDeployConfig,
      owner,
      protocolBeneficiary,
      lpBps: '2500',
      streamingPeriod: '86400',
      name: 'Custom Vault',
      symbol: 'CVLT',
      readRouterAsset: async () => asset,
    });

    expect(inferred.config.name).to.equal('Custom Vault');
    expect(inferred.config.symbol).to.equal('CVLT');
  });

  it('rejects chains outside the selected route', async () => {
    let thrown: Error | undefined;
    try {
      await inferWarpFeeVaultDeployConfig({
        chain: 'arbitrum',
        multiProvider,
        warpCoreConfig,
        warpDeployConfig,
        owner,
        protocolBeneficiary,
        lpBps: '2500',
        streamingPeriod: '86400',
        readRouterAsset: async () => asset,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include(
      'Chain arbitrum is not part of the selected warp route',
    );
  });

  it('rejects non-EVM chains', async () => {
    let thrown: Error | undefined;
    try {
      await inferWarpFeeVaultDeployConfig({
        chain: 'solana',
        multiProvider: {
          getProtocol: () => ProtocolType.Sealevel,
        } as any,
        warpCoreConfig: {
          tokens: [
            {
              chainName: 'solana',
              standard: TokenStandard.SealevelHypSynthetic,
              decimals: 9,
              symbol: 'USDC',
              name: 'USD Coin',
              addressOrDenom: 'So11111111111111111111111111111111111111112',
            },
          ],
        },
        warpDeployConfig: {
          solana: {
            type: TokenType.synthetic,
            owner,
          },
        } as any,
        owner,
        protocolBeneficiary,
        lpBps: '2500',
        streamingPeriod: '86400',
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.include(
      'Warp fee vault deploy only supports EVM-like chains',
    );
  });
});
