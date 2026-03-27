import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import type { ChainMap } from '../types.js';

import { createChainMetadataResolver } from './ChainMetadataResolver.js';
import type { ChainMetadata } from './chainMetadataTypes.js';

describe('createChainMetadataResolver', () => {
  const metadata = {
    ethereum: {
      name: 'ethereum',
      domainId: 1,
      chainId: 1,
      protocol: ProtocolType.Ethereum,
      rpcUrls: [{ http: 'https://ethereum.invalid' }],
    },
    cosmoshub: {
      name: 'cosmoshub',
      domainId: 2,
      chainId: 'cosmoshub-4',
      protocol: ProtocolType.Cosmos,
      rpcUrls: [{ http: 'https://cosmos.invalid' }],
      bech32Prefix: 'cosmos',
      slip44: 118,
      restUrls: [],
      grpcUrls: [],
    },
  } satisfies ChainMap<ChainMetadata>;

  it('resolves numeric chain IDs passed as strings', () => {
    const resolver = createChainMetadataResolver(metadata);

    expect(resolver.tryGetChainMetadata('ethereum')?.name).to.equal('ethereum');
    expect(resolver.tryGetChainMetadata('1')?.name).to.equal('ethereum');
    expect(resolver.tryGetChainMetadata(1)?.name).to.equal('ethereum');
    expect(resolver.tryGetChainName('1')).to.equal('ethereum');
    expect(resolver.tryGetChainName(1)).to.equal('ethereum');
  });

  it('resolves non-numeric string chain IDs', () => {
    const resolver = createChainMetadataResolver(metadata);

    expect(resolver.tryGetChainMetadata('cosmoshub-4')?.name).to.equal(
      'cosmoshub',
    );
  });

  it('prioritizes numeric chainId lookups consistently for strings and numbers', () => {
    const resolver = createChainMetadataResolver({
      ...metadata,
      domainOnly: {
        name: 'domainOnly',
        domainId: 10,
        chainId: 999,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://domain.invalid' }],
      },
      chainOnly: {
        name: 'chainOnly',
        domainId: 1111,
        chainId: 10,
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://chain.invalid' }],
      },
    });

    expect(resolver.tryGetChainMetadata('10')?.name).to.equal('chainOnly');
    expect(resolver.tryGetChainMetadata(10)?.name).to.equal('chainOnly');
  });
});
