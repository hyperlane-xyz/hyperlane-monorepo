import { expect } from 'chai';

import { ethereum } from '../consts/chainMetadata';
import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

describe('MultiProtocolProvider', () => {
  describe('constructs', () => {
    it('creates a multi protocol provider without type extension', async () => {
      const multiProvider = new MultiProtocolProvider();
      const ethMetadata = multiProvider.getChainMetadata(Chains.ethereum);
      expect(ethMetadata.name).to.equal(Chains.ethereum);
    });
    it('creates a multi protocol provider with type extension', async () => {
      const multiProvider = new MultiProtocolProvider<{
        ism: string;
        count: number;
      }>({
        [Chains.ethereum]: { ...ethereum, ism: '0x123', count: 1 },
      });
      const ethMetadata = multiProvider.getChainMetadata(Chains.ethereum);
      expect(ethMetadata.ism).to.equal('0x123');
      expect(ethMetadata.count).to.equal(1);
    });
  });
});
