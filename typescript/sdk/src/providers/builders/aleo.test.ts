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
      // CAST: The fake only implements methods exercised by this proxy test.
      (async (network: string | number) => {
        expect(network).to.equal(0);
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

  it('selects and caches each configured network independently', async () => {
    const loadedNetworks: (string | number)[] = [];

    class FakeAleoProvider {
      constructor(
        public readonly rpcUrls: string[],
        public readonly network: string | number,
      ) {}

      async getHeight() {
        return +this.network;
      }
    }

    const loadProvider = async (network: string | number) => {
      loadedNetworks.push(network);
      return { AleoProvider: FakeAleoProvider };
    };
    const mainnetProvider = createLazyAleoProvider(
      ['https://rpc.example/mainnet'],
      0,
      // CAST: The fake only implements methods exercised by this proxy test.
      loadProvider as unknown as Parameters<typeof createLazyAleoProvider>[2],
    );
    const testnetProvider = createLazyAleoProvider(
      ['https://rpc.example/testnet'],
      1,
      // CAST: The fake only implements methods exercised by this proxy test.
      loadProvider as unknown as Parameters<typeof createLazyAleoProvider>[2],
    );

    expect(loadedNetworks).to.deep.equal([]);
    expect(await mainnetProvider.getHeight()).to.equal(0);
    expect(await mainnetProvider.getHeight()).to.equal(0);
    expect(loadedNetworks).to.deep.equal([0]);
    expect(await testnetProvider.getHeight()).to.equal(1);
    expect(loadedNetworks).to.deep.equal([0, 1]);
  });

  it('rejects unsupported Aleo network ids before loading a runtime', async () => {
    const provider = createLazyAleoProvider(['https://rpc.example'], 2);

    const error = await provider.getHeight().then(
      () => undefined,
      (reason: unknown) => String(reason),
    );
    expect(error).to.equal('Error: Unsupported Aleo network id 2');
  });
});
