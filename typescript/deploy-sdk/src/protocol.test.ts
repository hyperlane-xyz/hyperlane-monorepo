import { expect } from 'chai';

import { ProtocolType, hasProtocol } from '@hyperlane-xyz/provider-sdk';

import { loadProtocolProviders } from './protocol.js';

describe('loadProtocolProviders', () => {
  it('registers Starknet protocol provider', async () => {
    await loadProtocolProviders(new Set([ProtocolType.Starknet]));
    expect(hasProtocol(ProtocolType.Starknet)).to.be.true;
  });

  it('is idempotent for already-registered Starknet protocol provider', async () => {
    await loadProtocolProviders(new Set([ProtocolType.Starknet]));
    await loadProtocolProviders(new Set([ProtocolType.Starknet]));
    expect(hasProtocol(ProtocolType.Starknet)).to.be.true;
  });
});
