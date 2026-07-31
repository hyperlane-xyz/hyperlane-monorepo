import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../../metadata/chainMetadataTypes.js';
import { ProviderType } from '../ProviderType.js';

import {
  createLazyRadixProvider,
  defaultRadixProviderBuilder,
} from './radix.browser.js';

function radixMetadata(
  chainId: number | string = 1,
  rpcUrls: Array<{ http: string }> = [{ http: 'https://rpc.example' }],
): ChainMetadata {
  return {
    name: 'radix',
    chainId,
    domainId: 1,
    protocol: ProtocolType.Radix,
    rpcUrls,
  };
}

describe('createLazyRadixProvider', () => {
  it('builds a lazy provider while preserving synchronous RPC URLs', () => {
    const result = defaultRadixProviderBuilder(radixMetadata());

    expect(result.type).to.equal(ProviderType.Radix);
    expect(result.provider.getRpcUrls()).to.deep.equal(['https://rpc.example']);
  });

  it('loads and reuses the Radix runtime on first async use', async () => {
    let loadCount = 0;
    let constructionCount = 0;
    const metadata = radixMetadata();

    class FakeRadixProvider {
      constructor(
        public readonly options: {
          rpcUrls: string[];
          networkId: number;
          chainMetadata: ChainMetadata;
        },
      ) {
        expect(options).to.deep.equal({
          rpcUrls: ['https://rpc.example'],
          networkId: 1,
          chainMetadata: metadata,
        });
        constructionCount++;
      }

      async isHealthy() {
        return true;
      }

      async getHeight() {
        return this.options.networkId;
      }

      async getTokenMetadata(resource: string) {
        return {
          name: resource,
          symbol: 'TKN',
          description: '',
          decimals: 18,
        };
      }
    }

    const provider = createLazyRadixProvider(
      metadata,
      // CAST: The fake implements only the methods exercised by this proxy test.
      (async () => {
        loadCount++;
        return { RadixProvider: FakeRadixProvider };
      }) as unknown as Parameters<typeof createLazyRadixProvider>[1],
    );

    expect(provider.getRpcUrls()).to.deep.equal(['https://rpc.example']);
    expect(loadCount).to.equal(0);
    expect(constructionCount).to.equal(0);

    const [healthy, height] = await Promise.all([
      provider.isHealthy(),
      provider.getHeight(),
    ]);

    expect(healthy).to.equal(true);
    expect(height).to.equal(1);
    expect(loadCount).to.equal(1);
    expect(constructionCount).to.equal(1);
    expect(await provider.getHeight()).to.equal(1);
    expect(await provider.getTokenMetadata('resource_rdx1token')).to.deep.equal(
      {
        name: 'resource_rdx1token',
        symbol: 'TKN',
        description: '',
        decimals: 18,
      },
    );
    expect(loadCount).to.equal(1);
  });

  it('validates metadata without loading the runtime', () => {
    expect(() => createLazyRadixProvider(radixMetadata(1, []))).to.throw(
      'Radix requires at least one rpcUrl',
    );
    expect(() => createLazyRadixProvider(radixMetadata('mainnet'))).to.throw(
      'Radix requires a numeric network id',
    );
  });
});
