import { expect } from 'chai';

import { readChainConfigs } from './chain.js';

describe('readChainConfigs', () => {
  const chainToMetadata = readChainConfigs('./examples/chain-config.yaml');

  it('parses and validates correctly', () => {
    expect(chainToMetadata.chainId).to.equal(1234567890);
  });
});
