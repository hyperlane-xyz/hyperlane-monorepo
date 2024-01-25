import { expect } from 'chai';

import { readChainConfigs } from './chain.js';

describe('readChainConfigs', () => {
  const chainToMetadata = readChainConfigs('./examples/chain-config.yaml');

  it('parses and validates correctly', () => {
    expect(chainToMetadata.mychainname.chainId).to.equal(1234567890);
  });

  it('merges core configs', () => {
    expect(chainToMetadata.sepolia.chainId).to.equal(11155111);
    expect(chainToMetadata.sepolia.rpcUrls[0].http).to.equal(
      'https://mycustomrpc.com',
    );
  });
});
