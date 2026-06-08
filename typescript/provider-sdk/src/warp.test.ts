import { expect } from 'chai';

import { ArtifactComposition } from './artifact.js';
import { TokenType, resolveFeeTokenFromWarpArtifactConfig } from './warp.js';
import type {
  CollateralWarpArtifactConfig,
  CrossCollateralWarpArtifactConfig,
  NativeWarpArtifactConfig,
  SyntheticWarpArtifactConfig,
} from './warp.js';

interface BaseSharedFixture {
  composition: typeof ArtifactComposition.ORCHESTRATED;
  owner: string;
  mailbox: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
}

describe('resolveFeeTokenFromWarpArtifactConfig', () => {
  const baseShared: BaseSharedFixture = {
    composition: ArtifactComposition.ORCHESTRATED,
    owner: '0x1',
    mailbox: '0xMailbox',
    remoteRouters: {},
    destinationGas: {},
  };

  it('returns the collateral token for collateral warps', () => {
    const config: CollateralWarpArtifactConfig = {
      ...baseShared,
      type: TokenType.collateral,
      token: '0xCollateralToken',
    };
    expect(resolveFeeTokenFromWarpArtifactConfig(config)).to.equal(
      '0xCollateralToken',
    );
  });

  it('returns the collateral token for crossCollateral warps', () => {
    const config: CrossCollateralWarpArtifactConfig = {
      ...baseShared,
      type: TokenType.crossCollateral,
      token: '0xCCollateralToken',
      crossCollateralRouters: {},
    };
    expect(resolveFeeTokenFromWarpArtifactConfig(config)).to.equal(
      '0xCCollateralToken',
    );
  });

  it('returns the deployed token for synthetic warps when populated', () => {
    const config: SyntheticWarpArtifactConfig = {
      ...baseShared,
      type: TokenType.synthetic,
      name: 'X',
      symbol: 'X',
      decimals: 9,
      token: '0xSyntheticToken',
    };
    expect(resolveFeeTokenFromWarpArtifactConfig(config)).to.equal(
      '0xSyntheticToken',
    );
  });

  it('returns undefined for synthetic warps before deploy', () => {
    const config: SyntheticWarpArtifactConfig = {
      ...baseShared,
      type: TokenType.synthetic,
      name: 'X',
      symbol: 'X',
      decimals: 9,
    };
    expect(resolveFeeTokenFromWarpArtifactConfig(config)).to.equal(undefined);
  });

  it('returns undefined for native warps', () => {
    const config: NativeWarpArtifactConfig = {
      ...baseShared,
      type: TokenType.native,
    };
    expect(resolveFeeTokenFromWarpArtifactConfig(config)).to.equal(undefined);
  });
});
