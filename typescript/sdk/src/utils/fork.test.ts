import { expect } from 'chai';

import { AnvilFork, getLocalProvider } from './fork.js';

describe(AnvilFork.name, () => {
  it('builds providers from the configured anvil endpoint', () => {
    const provider = new AnvilFork({
      anvilIPAddr: '://127.0.0.1',
      anvilPort: 9555,
    }).getProvider();

    expect(provider.connection.url).to.equal('http://127.0.0.1:9555');
  });

  it('supports updating endpoint configuration with setters', () => {
    const manager = new AnvilFork()
      .setAnvilIPAddr('://127.0.0.1')
      .setAnvilPort(9666);

    expect(manager.getProvider().connection.url).to.equal(
      'http://127.0.0.1:9666',
    );

    manager.setUrlOverride('http://127.0.0.1:9777');

    expect(manager.getProvider().connection.url).to.equal(
      'http://127.0.0.1:9777',
    );
  });
});

describe(getLocalProvider.name, () => {
  it('falls back to the configured anvil endpoint for invalid URL overrides', () => {
    const provider = getLocalProvider({
      anvilIPAddr: '://127.0.0.1',
      anvilPort: 9888,
      urlOverride: '127.0.0.1:9999',
    });

    expect(provider.connection.url).to.equal('http://127.0.0.1:9888');
  });
});
