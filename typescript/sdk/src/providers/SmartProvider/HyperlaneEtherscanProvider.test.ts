import { expect } from 'chai';
import sinon from 'sinon';

import { HyperlaneEtherscanProvider } from './HyperlaneEtherscanProvider.js';

describe('HyperlaneEtherscanProvider hostname', () => {
  afterEach(() => sinon.restore());

  it('reuses the parsed host and refreshes it when the explorer URL changes', () => {
    const provider = new HyperlaneEtherscanProvider(
      {
        name: 'explorer',
        url: 'https://explorer.test',
        apiUrl: 'https://user:password@EXPLORER.TEST:443/api',
        apiKey: 'test-key',
      },
      { chainId: 1, name: 'test' },
    );
    const URLConstructor = globalThis.URL;
    let parses = 0;
    sinon.stub(globalThis, 'URL').value(
      class extends URLConstructor {
        constructor(input: string | URL, base?: string | URL) {
          super(input, base);
          parses++;
        }
      },
    );

    expect(provider.getHostname()).to.equal('explorer.test');
    expect(provider.getHostname()).to.equal('explorer.test');
    expect(parses).to.equal(1);
    provider.explorerConfig.apiUrl = 'https://[::1]:8443/api';
    expect(provider.getHostname()).to.equal('[::1]');
    expect(provider.getHostname()).to.equal('[::1]');
    expect(parses).to.equal(2);
    provider.explorerConfig.apiUrl = 'not-a-url';
    expect(() => provider.getHostname()).to.throw();
  });
});
