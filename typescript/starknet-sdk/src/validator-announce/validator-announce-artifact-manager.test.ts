import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';

import { StarknetValidatorAnnounceArtifactManager } from './validator-announce-artifact-manager.js';

describe('StarknetValidatorAnnounceArtifactManager', () => {
  const chainMetadata: ChainMetadataForAltVM = {
    name: 'starknetsepolia',
    protocol: ProtocolType.Starknet,
    chainId: 'SN_SEPOLIA',
    domainId: 421614,
    rpcUrls: [{ http: 'http://localhost:9545' }],
  };

  it('throws for unsupported reader type', () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createReader('unsupported');
    }).to.throw(/Unsupported Starknet validator announce type/i);
  });

  it('throws for unsupported writer type', () => {
    const manager = new StarknetValidatorAnnounceArtifactManager(chainMetadata);
    expect(() => {
      // @ts-expect-error testing runtime validation for unsupported value
      manager.createWriter('unsupported', {});
    }).to.throw(/Unsupported Starknet validator announce type/i);
  });
});
