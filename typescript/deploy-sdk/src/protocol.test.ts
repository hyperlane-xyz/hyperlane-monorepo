import { expect } from 'vitest';

import {
  ProtocolType,
  getProtocolProvider,
  hasProtocol,
} from '@hyperlane-xyz/provider-sdk';

import { loadProtocolProviders } from './protocol.js';

describe('loadProtocolProviders', () => {
  it('registers Starknet provider implementation', async () => {
    await loadProtocolProviders(new Set([ProtocolType.Starknet]));

    expect(hasProtocol(ProtocolType.Starknet)).toBe(true);

    const provider = getProtocolProvider(ProtocolType.Starknet);
    expect(provider).toHaveProperty('createProvider');
    expect(provider).toHaveProperty('createSigner');
    expect(provider).toHaveProperty('createIsmArtifactManager');
  });
});
