import { expect } from 'chai';

import { ethereum } from '../consts/chainMetadata';
import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';

// const PROTOCOL_TO_TX: Record<ProtocolType,TypedTransaction> = {
//   []
// }

describe('MultiProtocolProvider', () => {
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

  it('creates providers for core chains', async () => {
    const multiProvider = new MultiProtocolProvider();
    for (const chain of Object.values(Chains)) {
      multiProvider.getProvider(chain);
    }
  });

  //TODO
  // it('estimates transaction gas core chains', async () => {
  //   const multiProvider = new MultiProtocolProvider();
  //   for (const chain of Object.values(Chains)) {
  //     multiProvider.getProvider(chain);
  //   }
  // });
});
