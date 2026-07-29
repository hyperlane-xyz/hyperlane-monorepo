import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { ProviderType } from '../ProviderType.js';

import {
  createLazyAleoProvider,
  defaultAleoProviderBuilder,
} from './aleo.browser.js';

function aleoMetadata(chainId: number, rpcUrl: string): ChainMetadata {
  return {
    name: `aleo${chainId}`,
    chainId,
    domainId: chainId,
    protocol: ProtocolType.Aleo,
    rpcUrls: [{ http: rpcUrl }],
  };
}

describe('createLazyAleoProvider', () => {
  it('builds a lazy provider from full chain metadata', () => {
    const result = defaultAleoProviderBuilder(
      aleoMetadata(0, 'https://rpc.example/mainnet'),
    );

    expect(result.type).to.equal(ProviderType.Aleo);
    expect(result.provider.getRpcUrls()).to.deep.equal(['https://rpc.example']);
  });

  it('loads and reuses the Aleo runtime on first async provider use', async () => {
    let loadCount = 0;
    let constructionCount = 0;
    const metadata = aleoMetadata(0, 'https://rpc.example/mainnet');

    class FakeAleoProvider {
      constructor(
        public readonly rpcUrls: string[],
        public readonly network: string | number,
        public readonly chainMetadata: ChainMetadata,
      ) {
        expect(chainMetadata).to.equal(metadata);
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
      metadata,
      // CAST: The fake only implements methods exercised by this proxy test.
      (async (network: string | number) => {
        expect(network).to.equal(0);
        loadCount++;
        return { AleoProvider: FakeAleoProvider };
      }) as unknown as Parameters<typeof createLazyAleoProvider>[1],
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
        public readonly chainMetadata: ChainMetadata,
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
      aleoMetadata(0, 'https://rpc.example/mainnet'),
      // CAST: The fake only implements methods exercised by this proxy test.
      loadProvider as unknown as Parameters<typeof createLazyAleoProvider>[1],
    );
    const testnetProvider = createLazyAleoProvider(
      aleoMetadata(1, 'https://rpc.example/testnet'),
      // CAST: The fake only implements methods exercised by this proxy test.
      loadProvider as unknown as Parameters<typeof createLazyAleoProvider>[1],
    );

    expect(loadedNetworks).to.deep.equal([]);
    expect(await mainnetProvider.getHeight()).to.equal(0);
    expect(await mainnetProvider.getHeight()).to.equal(0);
    expect(loadedNetworks).to.deep.equal([0]);
    expect(await testnetProvider.getHeight()).to.equal(1);
    expect(loadedNetworks).to.deep.equal([0, 1]);
  });

  it('rejects unsupported Aleo network ids before loading a runtime', async () => {
    const provider = createLazyAleoProvider(
      aleoMetadata(2, 'https://rpc.example'),
    );

    const error = await provider.getHeight().then(
      () => undefined,
      (reason: unknown) => String(reason),
    );
    expect(error).to.equal('Error: Unsupported Aleo network id 2');
  });
});
