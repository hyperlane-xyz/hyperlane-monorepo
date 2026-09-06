import { expect } from 'chai';

import { createLocalProvider } from './LocalProvider.js';

describe('createLocalProvider', () => {
  it('uses fast polling for each fresh local provider', () => {
    const url = 'http://127.0.0.1:8545';
    const first = createLocalProvider(url);
    const replacement = createLocalProvider(url);

    expect(first.pollingInterval).to.equal(100);
    expect(replacement.pollingInterval).to.equal(100);
    expect(replacement).not.to.equal(first);
    expect(replacement.connection.url).to.equal(url);
  });
});
