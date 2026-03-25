import { expect } from 'chai';

import { TestChainName, test1 } from '../consts/testChains.js';
import { ConfiguredMultiProtocolProvider } from '../providers/ConfiguredMultiProtocolProvider.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

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
      const configuredProvider = new ConfiguredMultiProtocolProvider({
        test1,
      });
      const multiProvider = new MultiProtocolProvider({ test1 });

      expect(configuredProvider.logger.bindings().module).to.equal(
        'ConfiguredMultiProtocolProvider',
      );
      expect(multiProvider.logger.bindings().module).to.equal(
        'MultiProtocolProvider',
      );
    });
  });
});
