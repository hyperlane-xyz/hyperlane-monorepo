import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { normalizeKeyFunderProtocol } from './utils.js';

describe('normalizeKeyFunderProtocol', () => {
  it('maps Cosmos metadata to the CosmosNative signer protocol', () => {
    expect(normalizeKeyFunderProtocol(ProtocolType.Cosmos)).to.equal(
      ProtocolType.CosmosNative,
    );
  });

  it('leaves already supported signer protocols unchanged', () => {
    expect(normalizeKeyFunderProtocol(ProtocolType.Ethereum)).to.equal(
      ProtocolType.Ethereum,
    );
    expect(normalizeKeyFunderProtocol(ProtocolType.CosmosNative)).to.equal(
      ProtocolType.CosmosNative,
    );
    expect(normalizeKeyFunderProtocol(ProtocolType.Sealevel)).to.equal(
      ProtocolType.Sealevel,
    );
  });
});
