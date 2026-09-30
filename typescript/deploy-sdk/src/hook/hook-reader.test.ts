import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  HookType,
  IRawHookArtifactManager,
} from '@hyperlane-xyz/provider-sdk/hook';

import { HookReader } from './hook-reader.js';

chai.use(chaiAsPromised);

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: () => null,
  getChainName: () => null,
  getKnownChainNames: () => [],
};

describe('HookReader', () => {
  it('rejects nested hook artifacts until expansion is supported', async () => {
    const artifactManager = {
      createReader: sinon.stub(),
      createWriter: sinon.stub(),
      readHook: sinon.stub().resolves({
        artifactState: ArtifactState.DEPLOYED,
        config: {
          type: HookType.AGGREGATION,
          hooks: [
            {
              artifactState: ArtifactState.UNDERIVED,
              deployed: { address: '0xnested' },
            },
          ],
        },
        deployed: { address: '0xaggregation' },
      }),
    } as IRawHookArtifactManager;
    const reader = new HookReader(artifactManager, chainLookup);

    await expect(reader.read('0xaggregation')).to.be.rejectedWith(
      `Nested hook artifact type ${HookType.AGGREGATION} is not yet supported by HookReader`,
    );
  });
});
