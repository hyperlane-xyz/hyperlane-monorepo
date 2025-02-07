import { expect } from 'chai';

import { TestChainName, test1 } from '../consts/testChains.js';
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
  });
});
