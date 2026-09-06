import { expect } from 'chai';
import { providers } from 'ethers';

import { configureLocalPolling, createLocalProvider } from './localProvider.js';

describe('local test provider polling', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    it(`uses fast polling on ${host}, including replacement providers`, () => {
      const url = `http://${host}:8545`;
      const first = createLocalProvider(url);
      const replacement = createLocalProvider(url);
      expect(first.pollingInterval).to.equal(100);
      expect(replacement.pollingInterval).to.equal(100);
      expect(first).not.to.equal(replacement);
      expect(replacement.connection.url).to.equal(url);
    });
  }

  it('preserves remote provider polling', () => {
    expect(createLocalProvider('https://example.com').pollingInterval).to.equal(
      4000,
    );
  });

  it('preserves polling for mixed or empty RPC lists', () => {
    for (const urls of [[], ['http://localhost:8545', 'https://example.com']]) {
      const provider = new providers.JsonRpcProvider('http://localhost:8545');
      configureLocalPolling(provider, urls);
      expect(provider.pollingInterval).to.equal(4000);
    }
  });
});
