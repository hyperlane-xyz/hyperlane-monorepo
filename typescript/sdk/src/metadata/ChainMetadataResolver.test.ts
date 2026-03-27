import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { createChainMetadataResolver } from './ChainMetadataResolver.js';
import type { ChainMetadata } from './chainMetadataTypes.js';

describe(createChainMetadataResolver.name, () => {
  const metadata: Record<string, ChainMetadata> = {
    ethereum: {
      chainId: 1,
      domainId: 1,
      name: 'ethereum',
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://ethereum.example.com' }],
    },
    sepolia: {
      chainId: '11155111',
      domainId: 11155111,
      name: 'sepolia',
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://sepolia.example.com' }],
    },
    cosmos: {
      chainId: 'cosmoshub-4',
      domainId: 118,
      name: 'cosmos',
      protocol: ProtocolType.Cosmos,
      rpcUrls: [{ http: 'https://cosmos.example.com' }],
      bech32Prefix: 'cosmos',
      slip44: 118,
      restUrls: [],
      grpcUrls: [],
    },
  };

  it('supports chain-name lookups', () => {
    const resolver = createChainMetadataResolver(metadata);
    expect(resolver.tryGetChainMetadata('ethereum')).to.equal(
      metadata.ethereum,
    );
    expect(resolver.tryGetChainName('cosmos')).to.equal('cosmos');
  });

  it('supports domain-id lookups', () => {
    const resolver = createChainMetadataResolver(metadata);
    expect(resolver.tryGetChainMetadata(1)).to.equal(metadata.ethereum);
    expect(resolver.tryGetProtocol(118)).to.equal(ProtocolType.Cosmos);
  });

  it('supports numeric chain-id string aliases', () => {
    const resolver = createChainMetadataResolver(metadata);
    expect(resolver.tryGetChainMetadata('11155111')).to.equal(metadata.sepolia);
    expect(resolver.tryGetChainMetadata(11155111)).to.equal(metadata.sepolia);
  });

  it('does not mishandle non-numeric chain ids', () => {
    const resolver = createChainMetadataResolver(metadata);
    expect(resolver.tryGetChainMetadata('cosmoshub-4')).to.equal(
      metadata.cosmos,
    );
    expect(resolver.tryGetChainMetadata(4)).to.equal(null);
  });
});
