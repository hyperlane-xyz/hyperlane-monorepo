import { expect } from 'chai';

import {
  ChainDisabledReason,
  type ChainMetadata,
  ChainStatus,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  filterChainMetadataByProtocol,
  filterOutDeprecatedChains,
} from './chains.js';

describe('filterChainMetadataByProtocol', () => {
  const mockEvmChain: ChainMetadata = {
    name: 'ethereum',
    chainId: 1,
    domainId: 1,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8545' }],
  };

  const mockEvmChain2: ChainMetadata = {
    name: 'polygon',
    chainId: 137,
    domainId: 137,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8546' }],
  };

  const mockSealevelChain: ChainMetadata = {
    name: 'solana',
    chainId: 1399811149,
    domainId: 1399811149,
    protocol: ProtocolType.Sealevel,
    rpcUrls: [{ http: 'http://localhost:8899' }],
  };

  const mockCosmosChain: ChainMetadata = {
    name: 'cosmos',
    chainId: 'cosmoshub-4',
    domainId: 1234,
    protocol: ProtocolType.Cosmos,
    rpcUrls: [{ http: 'http://localhost:26657' }],
    bech32Prefix: 'cosmos',
    slip44: 118,
    restUrls: [],
    grpcUrls: [],
  };

  it('should return only EVM chains when filtering for Ethereum protocol', () => {
    const chainMetadata = {
      ethereum: mockEvmChain,
      solana: mockSealevelChain,
      cosmos: mockCosmosChain,
    };
    const multiProvider = new MultiProvider(chainMetadata);

    const result = filterChainMetadataByProtocol(
      chainMetadata,
      multiProvider,
      ProtocolType.Ethereum,
    );

    expect(Object.keys(result)).to.have.lengthOf(1);
    expect(result).to.have.property('ethereum');
    expect(result).to.not.have.property('solana');
    expect(result).to.not.have.property('cosmos');
  });

  it('should return only Sealevel chains when filtering for Sealevel protocol', () => {
    const chainMetadata = {
      ethereum: mockEvmChain,
      solana: mockSealevelChain,
    };
    const multiProvider = new MultiProvider(chainMetadata);

    const result = filterChainMetadataByProtocol(
      chainMetadata,
      multiProvider,
      ProtocolType.Sealevel,
    );

    expect(Object.keys(result)).to.have.lengthOf(1);
    expect(result).to.have.property('solana');
    expect(result).to.not.have.property('ethereum');
  });

  it('should return empty object when no chains match the protocol', () => {
    const chainMetadata = {
      ethereum: mockEvmChain,
    };
    const multiProvider = new MultiProvider(chainMetadata);

    const result = filterChainMetadataByProtocol(
      chainMetadata,
      multiProvider,
      ProtocolType.Sealevel,
    );

    expect(Object.keys(result)).to.have.lengthOf(0);
  });

  it('should return all chains when all match the protocol', () => {
    const chainMetadata = {
      ethereum: mockEvmChain,
      polygon: mockEvmChain2,
    };
    const multiProvider = new MultiProvider(chainMetadata);

    const result = filterChainMetadataByProtocol(
      chainMetadata,
      multiProvider,
      ProtocolType.Ethereum,
    );

    expect(Object.keys(result)).to.have.lengthOf(2);
    expect(result).to.have.property('ethereum');
    expect(result).to.have.property('polygon');
  });
});

describe('filterOutDeprecatedChains', () => {
  const baseChain: Omit<ChainMetadata, 'name'> = {
    chainId: 1,
    domainId: 1,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8545' }],
  };

  const deprecatedChain: ChainMetadata = {
    ...baseChain,
    name: 'deprecated',
    availability: {
      status: ChainStatus.Disabled,
      reasons: [ChainDisabledReason.Deprecated],
    },
  };

  const badRpcChain: ChainMetadata = {
    ...baseChain,
    name: 'badrpc',
    availability: {
      status: ChainStatus.Disabled,
      reasons: [ChainDisabledReason.BadRpc],
    },
  };

  const liveChain: ChainMetadata = {
    ...baseChain,
    name: 'live',
    availability: {
      status: ChainStatus.Live,
    },
  };

  const defaultChain: ChainMetadata = {
    ...baseChain,
    name: 'default',
  };

  it('should drop chains marked as deprecated', () => {
    const chainMetadata = {
      deprecated: deprecatedChain,
      badrpc: badRpcChain,
      live: liveChain,
      default: defaultChain,
    };

    const result = filterOutDeprecatedChains(chainMetadata);

    expect(result).to.not.have.property('deprecated');
    expect(result).to.have.property('badrpc');
    expect(result).to.have.property('live');
    expect(result).to.have.property('default');
  });
});
