import { expect } from 'chai';
import { Provider as ZKSyncProvider } from 'zksync-ethers';

import { TestChainName, test1 } from '../consts/testChains.js';
import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import { defaultProviderBuilderMap } from '../providers/defaultProviderBuilderMaps.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ProviderType } from '../providers/ProviderType.js';

describe('MultiProtocolProvider', () => {
  describe('constructs', () => {
    it('creates a multi protocol provider without type extension', async () => {
      const multiProvider = new MultiProtocolProvider({ test1 });
      const metadata = multiProvider.getChainMetadata(TestChainName.test1);
      expect(metadata.name).to.equal(TestChainName.test1);
    });
    it('creates a multi protocol provider with type extension', async () => {
      const multiProvider = new MultiProtocolProvider<{
        foo: string;
        bar: number;
      }>({
        test1: { ...test1, foo: '0x123', bar: 1 },
      });
      const metadata = multiProvider.getChainMetadata(TestChainName.test1);
      expect(metadata.foo).to.equal('0x123');
      expect(metadata.bar).to.equal(1);
    });

    it('keeps distinct logger module names for base and derived providers', () => {
      const adapter = new MultiProviderAdapter({
        test1,
      });
      const multiProvider = new MultiProtocolProvider({ test1 });

      expect(adapter.logger.bindings().module).to.equal('MultiProviderAdapter');
      expect(multiProvider.logger.bindings().module).to.equal(
        'MultiProtocolProvider',
      );
    });

    it('preserves zksync provider typing when adapting a MultiProvider', () => {
      const provider = new ZKSyncProvider('http://127.0.0.1:3050', 324);
      const multiProvider = new MultiProvider({
        zksync: {
          ...test1,
          name: 'zksync',
          domainId: 324,
          chainId: 324,
          technicalStack: ChainTechnicalStack.ZkSync,
        },
      });
      multiProvider.setProvider('zksync', provider);

      const adapted = MultiProtocolProvider.fromMultiProvider(multiProvider);
      expect(adapted.getProvider('zksync', ProviderType.ZkSync).type).to.equal(
        ProviderType.ZkSync,
      );
    });

    it('preserves zksync lazy provider typing when adapting a MultiProvider', () => {
      const multiProvider = new MultiProvider({
        zksync: {
          ...test1,
          name: 'zksync',
          domainId: 324,
          chainId: 324,
          technicalStack: ChainTechnicalStack.ZkSync,
        },
      });

      const adapter = MultiProviderAdapter.fromMultiProvider(multiProvider);
      const adapted = MultiProtocolProvider.fromMultiProvider(multiProvider);

      expect(adapter.getProvider('zksync').type).to.equal(ProviderType.ZkSync);
      expect(adapted.getProvider('zksync').type).to.equal(ProviderType.ZkSync);
    });

    it('returns a gnosis-typed builder entry', () => {
      const provider = defaultProviderBuilderMap[ProviderType.GnosisTxBuilder](
        [{ http: 'https://ethereum.example.com' }],
        1,
      );
      expect(provider.type).to.equal(ProviderType.GnosisTxBuilder);
    });
  });
});
