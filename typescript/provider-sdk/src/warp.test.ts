import { expect } from 'chai';

import { ArtifactState } from './artifact.js';
import {
  preserveCurrentWarpConfigIfUnset,
  TokenType,
  WarpArtifactConfig,
} from './warp.js';

describe('preserveCurrentWarpConfigIfUnset', () => {
  const baseConfig: WarpArtifactConfig = {
    type: TokenType.native,
    owner: '0xowner',
    mailbox: '0xmailbox',
    remoteRouters: {},
    destinationGas: {},
  };

  it('preserves underived ISM and hook addresses when config leaves them unset', () => {
    const result = preserveCurrentWarpConfigIfUnset(baseConfig, {
      ...baseConfig,
      interchainSecurityModule: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: '0xism' },
      },
      hook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: '0xhook' },
      },
    });

    expect(result.interchainSecurityModule).to.deep.equal({
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: '0xism' },
    });
    expect(result.hook).to.deep.equal({
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: '0xhook' },
    });
  });

  it('fails if current config still contains NEW nested artifacts', () => {
    expect(() =>
      preserveCurrentWarpConfigIfUnset(baseConfig, {
        ...baseConfig,
        interchainSecurityModule: {
          artifactState: ArtifactState.NEW,
          config: { type: 'testIsm' },
        },
      }),
    ).to.throw('Expected current ISM artifact to be on-chain');
  });
});
