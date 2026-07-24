import { expect } from 'chai';

import { createLazyAleoProvider } from './aleo.browser.js';

describe('createLazyAleoProvider', () => {
  it('loads and reuses the Aleo runtime on first async provider use', async () => {
    let loadCount = 0;
    let constructionCount = 0;

    class FakeAleoProvider {
      constructor(
        public readonly rpcUrls: string[],
        public readonly network: string | number,
      ) {
        constructionCount++;
      }

      async isHealthy() {
        return true;
      }

      async getHeight() {
        return 42;
      }

      getAleoClient() {
        return { getLatestHeight: async () => 42 };
      }
    }

    const provider = createLazyAleoProvider(
      ['https://rpc.example/mainnet'],
      0,
      (async () => {
        loadCount++;
        return { AleoProvider: FakeAleoProvider };
      }) as unknown as Parameters<typeof createLazyAleoProvider>[2],
    );

    expect(provider.getRpcUrls()).to.deep.equal(['https://rpc.example']);
    expect(loadCount).to.equal(0);
    expect(constructionCount).to.equal(0);

    expect(await provider.isHealthy()).to.equal(true);
    expect(await provider.getHeight()).to.equal(42);
    expect(await provider.getAleoClient().getLatestHeight()).to.equal(42);
    expect(loadCount).to.equal(1);
    expect(constructionCount).to.equal(1);
  });
});
