import { expect } from 'chai';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';

import { StarknetIsmArtifactManager } from './ism-artifact-manager.js';

describe('StarknetIsmArtifactManager', () => {
  const chainMetadata = {
    name: 'starknet-test',
    chainId: 1234,
    domainId: 1234,
    protocol: 'starknet',
    rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      denom: 'ETH',
    },
  } as any;

  it('creates readers for supported ISM types and rejects unsupported types', () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);

    expect(() => manager.createReader(AltVM.IsmType.TEST_ISM)).to.not.throw();
    expect(() =>
      manager.createReader('unsupportedIsm' as AltVM.IsmType),
    ).to.throw('Unsupported Starknet ISM type');
  });

  it('generates routing update transactions for add/remove/owner changes', async () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);

    const signer = {
      getSignerAddress: () => '0x99',
      getSetRoutingIsmRouteTransaction: async ({ route }: any) => ({
        kind: 'invoke',
        contractAddress: '0x1',
        entrypoint: 'set',
        calldata: [route.domainId],
      }),
      getRemoveRoutingIsmRouteTransaction: async ({ domainId }: any) => ({
        kind: 'invoke',
        contractAddress: '0x1',
        entrypoint: 'remove',
        calldata: [domainId],
      }),
      getSetRoutingIsmOwnerTransaction: async ({ newOwner }: any) => ({
        kind: 'invoke',
        contractAddress: '0x1',
        entrypoint: 'transfer_ownership',
        calldata: [newOwner],
      }),
    };

    const writer = manager.createWriter(
      AltVM.IsmType.ROUTING,
      signer as any,
    ) as any;

    writer.read = async () => ({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.IsmType.ROUTING,
        owner: '0x01',
        domains: {
          1000: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: '0x10' },
          },
          2000: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: '0x20' },
          },
        },
      },
      deployed: { address: '0xabc' },
    });

    const txs = await writer.update({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.IsmType.ROUTING,
        owner: '0x02',
        domains: {
          1000: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: '0x10' },
          },
          3000: {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: '0x30' },
          },
        },
      },
      deployed: { address: '0xabc' },
    });

    expect(txs).to.have.length(3);
    expect(txs[0].annotation).to.contain('Setting routing ISM route 3000');
    expect(txs[1].annotation).to.contain('Removing routing ISM route 2000');
    expect(txs[2].annotation).to.contain('Updating routing ISM owner');
  });
});
