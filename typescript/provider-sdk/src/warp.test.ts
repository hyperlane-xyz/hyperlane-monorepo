import { expect } from 'chai';

import { ArtifactState } from './artifact.js';
import { ChainLookup } from './chain.js';
import { ProtocolType } from './protocolType.js';
import {
  TokenType,
  UnsupportedWarpArtifactTypeError,
  computeRemoteRoutersUpdates,
  resolveFeeTokenFromWarpArtifactConfig,
  throwUnsupportedWarpType,
  warpArtifactToDerivedConfig,
} from './warp.js';
import type {
  CollateralWarpArtifactConfig,
  CollateralVaultWarpArtifactConfig,
  CrossCollateralWarpArtifactConfig,
  NativeWarpArtifactConfig,
  SyntheticWarpArtifactConfig,
} from './warp.js';

interface BaseSharedFixture {
  owner: string;
  mailbox: string;
  remoteRouters: Record<number, { address: string }>;
  destinationGas: Record<number, string>;
}

describe('unsupported warp artifact types', () => {
  it('includes the warp type and protocol', () => {
    const warpType = TokenType.crossCollateral;

    expect(() => throwUnsupportedWarpType(warpType, ProtocolType.Aleo))
      .to.throw(UnsupportedWarpArtifactTypeError)
      .and.include({
        warpType,
        protocol: ProtocolType.Aleo,
      });
  });

  it('rejects deriving an unsupported valid warp type', () => {
    const chainLookup: ChainLookup = {
      getChainMetadata: () => {
        throw new Error('not needed');
      },
      getDomainId: () => null,
      getChainName: () => null,
      getKnownChainNames: () => [],
    };
    const config: CollateralVaultWarpArtifactConfig = {
      owner: '0xOwner',
      mailbox: '0xMailbox',
      remoteRouters: {},
      destinationGas: {},
      type: TokenType.collateralVault,
      token: '0xToken',
    };

    expect(() =>
      warpArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config,
          deployed: { address: '0xWarp' },
        },
        chainLookup,
      ),
    ).to.throw(
      `Unsupported warp token type in warpArtifactToDerivedConfig: ${TokenType.collateralVault}`,
    );
  });
});

describe('resolveFeeTokenFromWarpArtifactConfig', () => {
  const baseShared: BaseSharedFixture = {
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

  it('rejects unsupported valid warp types', () => {
    const config: CollateralVaultWarpArtifactConfig = {
      ...baseShared,
      type: TokenType.collateralVault,
      token: '0xToken',
    };

    expect(() => resolveFeeTokenFromWarpArtifactConfig(config)).to.throw(
      `Unsupported warp token type in resolveFeeTokenFromWarpArtifactConfig: ${TokenType.collateralVault}`,
    );
  });
});

describe('computeRemoteRoutersUpdates', () => {
  const eq = (a: string, b: string) => a === b;
  const DOMAIN = 1234;

  it('keeps current gas for an existing router when expected omits it', () => {
    const current = {
      remoteRouters: { [DOMAIN]: { address: '0xRouter' } },
      destinationGas: { [DOMAIN]: '200000' },
    };
    const expected = {
      remoteRouters: { [DOMAIN]: { address: '0xRouter' } },
      destinationGas: {},
    };

    const diff = computeRemoteRoutersUpdates(current, expected, eq);

    expect(diff.toEnroll).to.deep.equal([]);
    expect(diff.toUnenroll).to.deep.equal([]);
  });

  it('enrolls a new router with gas 0 when expected omits it', () => {
    const current = {
      remoteRouters: {},
      destinationGas: {},
    };
    const expected = {
      remoteRouters: { [DOMAIN]: { address: '0xRouter' } },
      destinationGas: {},
    };

    const diff = computeRemoteRoutersUpdates(current, expected, eq);

    expect(diff.toEnroll).to.deep.equal([
      { domainId: DOMAIN, routerAddress: '0xRouter', gas: '0' },
    ]);
    expect(diff.toUnenroll).to.deep.equal([]);
  });

  it('ignores orphaned current gas when enrolling a new router with omitted gas', () => {
    const current = {
      // Gas entry exists for the domain but no router is enrolled (orphaned).
      remoteRouters: {},
      destinationGas: { [DOMAIN]: '200000' },
    };
    const expected = {
      remoteRouters: { [DOMAIN]: { address: '0xRouter' } },
      destinationGas: {},
    };

    const diff = computeRemoteRoutersUpdates(current, expected, eq);

    expect(diff.toEnroll).to.deep.equal([
      { domainId: DOMAIN, routerAddress: '0xRouter', gas: '0' },
    ]);
    expect(diff.toUnenroll).to.deep.equal([]);
  });
});
