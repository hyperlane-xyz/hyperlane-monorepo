import { expect } from 'vitest';

import { readChainConfigs } from './chain.js';

describe('readChainConfigs', () => {
  const chainToMetadata = readChainConfigs('./examples/chain-config.yaml');

  it('parses and validates correctly', () => {
    expect(chainToMetadata.chainId).toBe(1234567890);
  });
});
