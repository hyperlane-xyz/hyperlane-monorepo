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
    expect(resolver.tryGetDomainId('11155111')).to.equal(
      metadata.sepolia.domainId,
    );
  });

  it('does not mishandle non-numeric chain ids', () => {
    const resolver = createChainMetadataResolver(metadata);
    expect(resolver.tryGetChainMetadata('cosmoshub-4')).to.equal(
      metadata.cosmos,
    );
    expect(resolver.tryGetChainMetadata(4)).to.equal(null);
  });

  it('allows duplicate chain ids and treats ambiguous aliases as unresolved', () => {
    const resolver = createChainMetadataResolver({
      foo: {
        ...metadata.ethereum,
        chainId: 31337,
        name: 'foo',
      },
      bar: {
        ...metadata.sepolia,
        chainId: '31337',
        domainId: 9999,
        name: 'bar',
      },
    });

    expect(resolver.tryGetChainMetadata('foo')?.name).to.equal('foo');
    expect(resolver.tryGetChainMetadata('bar')?.name).to.equal('bar');
    expect(resolver.tryGetChainMetadata('31337')).to.equal(null);
    expect(resolver.tryGetChainMetadata(31337)).to.equal(null);
  });

  it('throws on duplicate domain ids', () => {
    expect(() =>
      createChainMetadataResolver({
        foo: metadata.ethereum,
        bar: {
          ...metadata.sepolia,
          name: 'bar',
          domainId: metadata.ethereum.domainId,
        },
      }),
    ).to.throw('Duplicate domainId detected');
  });
});
