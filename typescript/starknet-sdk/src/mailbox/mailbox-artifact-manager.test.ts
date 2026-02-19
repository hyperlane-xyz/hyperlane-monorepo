import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetMailboxArtifactManager } from './mailbox-artifact-manager.js';

describe('StarknetMailboxArtifactManager', () => {
  const chainMetadata = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  } as any;

  it('throws for unsupported mailbox reader type', () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    expect(() => manager.createReader('unsupported' as any)).to.throw(
      /Unsupported Starknet mailbox type/i,
    );
  });

  it('throws for unsupported mailbox writer type', () => {
    const manager = new StarknetMailboxArtifactManager(chainMetadata);
    expect(() =>
      manager.createWriter('unsupported' as any, {
        getSignerAddress: () => '0x1',
      } as any),
    ).to.throw(/Unsupported Starknet mailbox type/i);
  });
});
