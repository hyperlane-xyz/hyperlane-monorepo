import { expect } from 'chai';
import { Wallet, providers as ethersProviders } from 'ethers';
import { Provider as ZKSyncProvider } from 'zksync-ethers';

import { TestChainName, test1, test2 } from '../consts/testChains.js';
import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import { defaultProviderBuilderMap } from '../providers/defaultProviderBuilderMaps.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ProviderType } from '../providers/ProviderType.js';
import { SeismicSigner } from '../providers/SeismicSigner.js';

describe('MultiProtocolProvider', () => {
  describe('seismic signers', () => {
    const seismic = {
      ...test2,
      name: 'seismic',
      technicalStack: ChainTechnicalStack.Seismic,
    };

    function multiProviderWithSigners() {
      const multiProvider = new MultiProvider({ test1, seismic });
      const provider = new ethersProviders.JsonRpcProvider(
        'http://127.0.0.1:8545',
      );
      multiProvider.setSharedSigner(Wallet.createRandom().connect(provider));
      return multiProvider;
    }

    it("exposes only Seismic chains' signers to adapters", () => {
      const adapted = MultiProtocolProvider.fromMultiProvider(
        multiProviderWithSigners(),
      );
      const signer = adapted.tryGetSeismicSigner('seismic');
      expect(signer).to.be.instanceOf(SeismicSigner);
      // Non-Seismic chains never get one, even though the MultiProvider has it.
      expect(adapted.tryGetSeismicSigner(TestChainName.test1)).to.equal(
        undefined,
      );
    });

    it('has no signers for read-only instances', () => {
      const readOnly = new MultiProtocolProvider({ test1, seismic });
      expect(readOnly.tryGetSeismicSigner('seismic')).to.equal(undefined);
    });

    it('adopts Seismic signers after construction and keeps them in derived instances', () => {
      // The CLI builds its MultiProtocolProvider from metadata first and
      // attaches keys later; signers are adopted in place.
      const adapted = new MultiProtocolProvider({ test1, seismic });
      adapted.setSeismicSigners(multiProviderWithSigners());
      expect(adapted.tryGetSeismicSigner('seismic')).to.be.instanceOf(
        SeismicSigner,
      );
      expect(adapted.tryGetSeismicSigner(TestChainName.test1)).to.equal(
        undefined,
      );
      const extended = adapted.extendChainMetadata({
        seismic: { mailbox: '0x1' },
      });
      expect(extended.tryGetSeismicSigner('seismic')).to.be.instanceOf(
        SeismicSigner,
      );
    });

    it('drops Seismic signers the source MultiProvider no longer has', () => {
      const source = multiProviderWithSigners();
      const adapted = new MultiProtocolProvider({ test1, seismic });
      adapted.setSeismicSigners(source);
      expect(adapted.tryGetSeismicSigner('seismic')).to.be.instanceOf(
        SeismicSigner,
      );
      source.setSharedSigner(null);
      adapted.setSeismicSigners(source);
      expect(adapted.tryGetSeismicSigner('seismic')).to.equal(undefined);
    });

    it('keeps Seismic signers across extendChainMetadata and intersect', () => {
      const adapted = MultiProtocolProvider.fromMultiProvider(
        multiProviderWithSigners(),
      );
      const extended = adapted.extendChainMetadata({
        seismic: { mailbox: '0x1' },
        test1: { mailbox: '0x2' },
      });
      expect(extended.tryGetSeismicSigner('seismic')).to.be.instanceOf(
        SeismicSigner,
      );
      const { result } = extended.intersect(['seismic']);
      expect(result.tryGetSeismicSigner('seismic')).to.be.instanceOf(
        SeismicSigner,
      );
    });
  });

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
      const provider =
        defaultProviderBuilderMap[ProviderType.GnosisTxBuilder](test1);
      expect(provider.type).to.equal(ProviderType.GnosisTxBuilder);
    });
  });
});
