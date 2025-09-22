import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../types.js';

import { ChainMetadataManager } from './ChainMetadataManager.js';
import {
  ChainDisabledReason,
  ChainMetadata,
  ChainStatus,
} from './chainMetadataTypes.js';

describe(ChainMetadataManager.name, () => {
  let manager: ChainMetadataManager;

  const ethereumMetadata: ChainMetadata = {
    chainId: 1,
    domainId: 1,
    name: 'ethereum',
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://ethereum.example.com' }],
  };

  const polygonMetadata: ChainMetadata = {
    chainId: 137,
    domainId: 137,
    name: 'polygon',
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://polygon.example.com' }],
  };

  const deprecatedChainMetadata: ChainMetadata = {
    chainId: 999,
    domainId: 999,
    name: 'deprecatedtestnet',
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://deprecated.example.com' }],
  };

  const disabledChainMetadata: ChainMetadata = {
    chainId: 888,
    domainId: 888,
    name: 'disabledchain',
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://disabled.example.com' }],
    availability: {
      status: ChainStatus.Disabled,
      reasons: [ChainDisabledReason.Unavailable],
    },
  };

  const cosmosMetadata: ChainMetadata = {
    chainId: 'cosmoshub-4',
    domainId: 118,
    name: 'cosmos',
    protocol: ProtocolType.Cosmos,
    rpcUrls: [{ http: 'https://cosmos.example.com' }],
    bech32Prefix: 'cosmos',
    slip44: 118,
    restUrls: [],
    grpcUrls: [],
  };

  const solanaMetadata: ChainMetadata = {
    chainId: 101,
    domainId: 1399811149,
    name: 'solana',
    protocol: ProtocolType.Sealevel,
    rpcUrls: [{ http: 'https://solana.example.com' }],
  };

  beforeEach(() => {
    manager = new ChainMetadataManager({
      ethereum: ethereumMetadata,
      polygon: polygonMetadata,
      deprecatedtestnet: deprecatedChainMetadata,
      disabledchain: disabledChainMetadata,
      cosmos: cosmosMetadata,
      solana: solanaMetadata,
    });
  });

  describe(ChainMetadataManager.prototype.tryGetChainMetadata.name, () => {
    describe('basic functionality', () => {
      const testCases: ReadonlyArray<{
        description: string;
        input: ChainNameOrId;
        expected: any;
      }> = [
        {
          description: 'valid chain name',
          input: 'ethereum',
          expected: ethereumMetadata,
        },
        {
          description: 'another valid chain name',
          input: 'polygon',
          expected: polygonMetadata,
        },
        {
          description: 'non-existent chain name',
          input: 'nonexistent',
          expected: null,
        },
        {
          description: 'valid domain ID',
          input: 1,
          expected: ethereumMetadata,
        },
        {
          description: 'another valid domain ID',
          input: 137,
          expected: polygonMetadata,
        },
        {
          description: 'non-existent domain ID',
          input: 99999,
          expected: null,
        },
      ];

      testCases.forEach(({ description, input, expected }) => {
        it(`should return correct result for ${description}`, () => {
          const result = manager.tryGetChainMetadata(input);

          expect(result).to.deep.equal(expected);
        });
      });
    });

    describe('deprecated chain filtering', () => {
      const testCases: ReadonlyArray<{
        description: string;
        input: ChainNameOrId;
        expected: any;
      }> = [
        {
          description: 'deprecated chain by domain ID',
          input: 999,
          expected: null,
        },
        {
          description: 'deprecated chain by chain ID',
          input: 999,
          expected: null,
        },
        {
          description: 'deprecated chain by exact name',
          input: 'deprecatedtestnet',
          expected: null,
        },
      ];

      testCases.forEach(({ description, input, expected }) => {
        it(`should filter out ${description}`, () => {
          const result = manager.tryGetChainMetadata(input);

          expect(result).to.deep.equal(expected);
        });
      });
    });

    describe('disabled chain filtering', () => {
      const testCases: ReadonlyArray<{
        description: string;
        input: ChainNameOrId;
        expected: any;
      }> = [
        {
          description: 'disabled chain by domain ID',
          input: 888,
          expected: null,
        },
        {
          description: 'disabled chain by chain ID',
          input: 888,
          expected: null,
        },
        {
          description: 'disabled chain by exact name',
          input: 'disabledchain',
          expected: null,
        },
      ];

      testCases.forEach(({ description, input, expected }) => {
        it(`should filter out ${description}`, () => {
          const result = manager.tryGetChainMetadata(input);

          expect(result).to.deep.equal(expected);
        });
      });
    });

    describe('different protocol types', () => {
      const testCases: ReadonlyArray<{
        description: string;
        input: ChainNameOrId;
        expected: any;
      }> = [
        {
          description: 'Cosmos chain by name',
          input: 'cosmos',
          expected: cosmosMetadata,
        },
        {
          description: 'Cosmos chain by domain ID',
          input: 118,
          expected: cosmosMetadata,
        },
        {
          description: 'Cosmos chain by string chain ID',
          input: 'cosmoshub-4',
          expected: cosmosMetadata,
        },
        {
          description: 'Sealevel chain by name',
          input: 'solana',
          expected: solanaMetadata,
        },
        {
          description: 'Sealevel chain by domain ID',
          input: 1399811149,
          expected: solanaMetadata,
        },
        {
          description: 'Sealevel chain by chain ID',
          input: 101,
          expected: solanaMetadata,
        },
      ];

      testCases.forEach(({ description, input, expected }) => {
        it(`should handle ${description}`, () => {
          const result = manager.tryGetChainMetadata(input);

          expect(result).to.deep.equal(expected);
        });
      });
    });
  });
});
