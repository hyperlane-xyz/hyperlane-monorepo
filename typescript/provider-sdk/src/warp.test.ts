import { expect } from 'chai';

import { ArtifactState } from './artifact.js';
import type { ChainLookup } from './chain.js';
import {
  TokenType,
  warpArtifactToDerivedConfig,
  warpConfigToArtifact,
} from './warp.js';

describe('crossCollateral warp config conversions', () => {
  const chainLookup: ChainLookup = {
    getChainMetadata: (_chain) => {
      throw new Error('unused');
    },
    getChainName: (domainId) => (domainId === 2000 ? 'test2' : null),
    getDomainId: (chain) => (chain === 'test2' ? 2000 : null),
    getKnownChainNames: () => ['test2'],
  };

  it('accepts numeric-string crossCollateral router keys when converting to artifacts', () => {
    const warnings: string[] = [];

    const artifact = warpConfigToArtifact(
      {
        type: TokenType.crossCollateral,
        owner: 'owner',
        mailbox: 'mailbox',
        token: 'token',
        crossCollateralRouters: {
          '1000': ['0xabc'],
          test2: ['0xdef'],
        },
      },
      chainLookup,
      { warn: (message: string) => warnings.push(message) } as any,
    );

    expect(artifact.config.type).to.equal(TokenType.crossCollateral);
    if (artifact.config.type !== TokenType.crossCollateral) return;

    expect(warnings).to.deep.equal([]);
    expect([...artifact.config.crossCollateralRouters[1000]]).to.deep.equal([
      '0xabc',
    ]);
    expect([...artifact.config.crossCollateralRouters[2000]]).to.deep.equal([
      '0xdef',
    ]);
  });

  it('preserves domain ids when converting unknown crossCollateral routers back to derived config', () => {
    const derived = warpArtifactToDerivedConfig(
      {
        artifactState: ArtifactState.DEPLOYED,
        deployed: { address: '0x1' },
        config: {
          type: TokenType.crossCollateral,
          owner: 'owner',
          mailbox: 'mailbox',
          token: 'token',
          remoteRouters: {},
          destinationGas: {},
          crossCollateralRouters: {
            1000: new Set(['0xabc']),
            2000: new Set(['0xdef']),
          },
        },
      },
      chainLookup,
    );

    expect(derived.type).to.equal(TokenType.crossCollateral);
    if (derived.type !== TokenType.crossCollateral) return;

    expect(derived.crossCollateralRouters).to.deep.equal({
      '1000': ['0xabc'],
      test2: ['0xdef'],
    });
  });
});
