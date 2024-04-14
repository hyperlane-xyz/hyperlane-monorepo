import { expect } from 'chai';

import { ethereum } from '../consts/chainMetadata.js';
import { Chains } from '../consts/chains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

describe('MultiProtocolProvider', () => {
  describe('constructs', () => {
    it('creates a multi protocol provider without type extension', async () => {
      const multiProvider = new MultiProtocolProvider();
      const ethMetadata = multiProvider.getChainMetadata(Chains.ethereum);
      expect(ethMetadata.name).to.equal(Chains.ethereum);
    });
    it('creates a multi protocol provider with type extension', async () => {
      const multiProvider = new MultiProtocolProvider<{
        foo: string;
        bar: number;
      }>({
        [Chains.ethereum]: { ...ethereum, foo: '0x123', bar: 1 },
      });
      const ethMetadata = multiProvider.getChainMetadata(Chains.ethereum);
      expect(ethMetadata.foo).to.equal('0x123');
      expect(ethMetadata.bar).to.equal(1);
    });
  });
});
