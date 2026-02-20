import { expect } from 'chai';

import {
  ProtocolType,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';

import { loadProtocolProviders } from './protocol.js';

describe('loadProtocolProviders', () => {
  it('registers Starknet provider implementation', async () => {
    await loadProtocolProviders(new Set([ProtocolType.Starknet]));

    expect(hasProtocol(ProtocolType.Starknet)).to.equal(true);

    const provider = getProtocolProvider(ProtocolType.Starknet);
    expect(provider).to.have.property('createProvider');
    expect(provider).to.have.property('createSigner');
    expect(provider).to.have.property('createIsmArtifactManager');
  });
});
