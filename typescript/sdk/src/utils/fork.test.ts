import { expect } from 'chai';

import { ANVIL_RPC_METHODS, AnvilFork, getLocalProvider } from './fork.js';

describe(AnvilFork.name, () => {
  it('builds providers from the configured anvil endpoint', () => {
    const provider = new AnvilFork({
      anvilIPAddr: '127.0.0.1',
      anvilPort: 9555,
    }).getProvider();

    expect(provider.connection.url).to.equal('http://127.0.0.1:9555');
  });

  it('supports updating endpoint configuration with setters', () => {
    const manager = new AnvilFork()
      .setAnvilIPAddr('http://127.0.0.1')
      .setAnvilPort(9666);

    expect(manager.getProvider().connection.url).to.equal(
      'http://127.0.0.1:9666',
    );

    manager.setUrlOverride('http://127.0.0.1:9777');

    expect(manager.getProvider().connection.url).to.equal(
      'http://127.0.0.1:9777',
    );
  });
  it('resets the local node without re-fork params', async () => {
    const sentRequests: unknown[][] = [];
    const manager = new AnvilFork();
    manager.getProvider = () =>
      ({
        send: async (method: string, params: unknown[]) => {
          sentRequests.push([method, params]);
        },
      }) as ReturnType<AnvilFork['getProvider']>;

    await manager.reset();

    expect(sentRequests).to.deep.equal([[ANVIL_RPC_METHODS.RESET, []]]);
  });
});

describe(getLocalProvider.name, () => {
  it('throws for invalid URL overrides', () => {
    expect(() =>
      getLocalProvider({
        anvilIPAddr: '127.0.0.1',
        anvilPort: 9888,
        urlOverride: '127.0.0.1:9999',
      }),
    ).to.throw('URL override must be a valid HTTP(S) URL');
  });
});
