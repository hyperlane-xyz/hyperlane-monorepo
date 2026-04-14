import { expect } from 'chai';
import sinon from 'sinon';

import { test1 } from '@hyperlane-xyz/sdk';

import { getProvidersFromRegistry } from '../../context/context.js';

describe('getProvidersFromRegistry', () => {
  it('reads registry metadata once and reuses it for both provider containers', async () => {
    const chainMetadata = { test1 };
    const registry = {
      getMetadata: sinon.stub().resolves(chainMetadata),
    };

    const providers = await getProvidersFromRegistry(registry as any);

    expect(registry.getMetadata.callCount).to.equal(1);
    expect(providers.chainMetadata).to.deep.equal(chainMetadata);
    expect(providers.multiProvider.metadata).to.deep.equal(chainMetadata);
    expect(providers.multiProtocolProvider.metadata).to.deep.equal(
      chainMetadata,
    );
  });
});
