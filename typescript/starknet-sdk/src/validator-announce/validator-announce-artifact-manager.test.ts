import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { StarknetValidatorAnnounceArtifactManager } from './validator-announce-artifact-manager.js';

describe('StarknetValidatorAnnounceArtifactManager', () => {
  const chainMetadata = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  } as any;

  it('throws for unsupported reader type', () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    expect(() => manager.createReader('unsupported' as any)).to.throw(
      /Unsupported Starknet validator announce type/i,
    );
  });

  it('throws for unsupported writer type', () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    expect(() =>
      manager.createWriter('unsupported' as any, {
        getSignerAddress: () => '0x1',
      } as any),
    ).to.throw(/Unsupported Starknet validator announce type/i);
  });
});
