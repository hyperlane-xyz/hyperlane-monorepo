import { expect } from 'chai';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetIsmArtifactManager } from './ism-artifact-manager.js';

describe('StarknetIsmArtifactManager', () => {
  const chainMetadata: ChainMetadataForAltVM = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  };

  it('throws for unsupported reader type', () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createReader('unsupported');
    }).to.throw(/Unsupported Starknet ISM type/i);
  });

  it('throws for unsupported writer type', () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createWriter('unsupported', {});
    }).to.throw(/Unsupported Starknet ISM type/i);
  });

  it('treats custom noop ISMs as testIsm on generic reads', async () => {
    const manager = new StarknetIsmArtifactManager(chainMetadata);
    const provider = Reflect.get(manager, 'provider') as {
      getIsmType: (_req: { ismAddress: string }) => Promise<AltVM.IsmType>;
      getNoopIsm: (_req: {
        ismAddress: string;
      }) => Promise<{ address: string }>;
    };
    provider.getIsmType = async () => AltVM.IsmType.CUSTOM;
    provider.getNoopIsm = async ({ ismAddress }) => ({ address: ismAddress });

    const artifact = await manager.readIsm('0xabc');

    expect(artifact.config).to.deep.equal({ type: 'testIsm' });
    expect(artifact.deployed.address).to.equal('0xabc');
  });
});
