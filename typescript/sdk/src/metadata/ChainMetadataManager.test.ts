import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from '../types.js';

import { ChainMetadataManager } from './ChainMetadataManager.js';
import {
  BlockExplorer,
  ChainMetadata,
  ExplorerFamily,
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
          description: 'Sealevel chain by name',
          input: 'solana',
          expected: solanaMetadata,
        },
        {
          description: 'Sealevel chain by domain ID',
          input: 1399811149,
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

  describe(
    ChainMetadataManager.prototype.tryGetEvmExplorerMetadata.name,
    () => {
      const etherscanExplorer: BlockExplorer = {
        name: 'Etherscan',
        url: 'https://etherscan.example.com',
        apiUrl: 'https://api.etherscan.example.com/api',
        apiKey: 'test-key',
        family: ExplorerFamily.Etherscan,
      };
      const etherscanNoKeyExplorer: BlockExplorer = {
        name: 'Etherscan',
        url: 'https://etherscan.example.com',
        apiUrl: 'https://api.etherscan.example.com/api',
        family: ExplorerFamily.Etherscan,
      };
      const blockscoutExplorer: BlockExplorer = {
        name: 'Blockscout',
        url: 'https://blockscout.example.com',
        apiUrl: 'https://blockscout.example.com/api',
        family: ExplorerFamily.Blockscout,
      };
      const tronScanExplorer: BlockExplorer = {
        name: 'TronScan',
        url: 'https://tronscan.example.com',
        apiUrl: 'https://tronscan.example.com/#/api',
        family: ExplorerFamily.TronScan,
      };

      interface Case {
        description: string;
        blockExplorers: BlockExplorer[];
        expectedFamily: ExplorerFamily | null;
      }

      const cases: Case[] = [
        {
          description:
            'TronScan default with no compatible fallback returns null',
          blockExplorers: [tronScanExplorer],
          expectedFamily: null,
        },
        {
          description: 'Etherscan with an api key returns the explorer',
          blockExplorers: [etherscanExplorer],
          expectedFamily: ExplorerFamily.Etherscan,
        },
        {
          description: 'Blockscout returns the explorer',
          blockExplorers: [blockscoutExplorer],
          expectedFamily: ExplorerFamily.Blockscout,
        },
        {
          description:
            'Etherscan without an api key falls back to Blockscout when present',
          blockExplorers: [etherscanNoKeyExplorer, blockscoutExplorer],
          expectedFamily: ExplorerFamily.Blockscout,
        },
      ];

      for (const c of cases) {
        it(c.description, () => {
          const chainManager = new ChainMetadataManager({
            testchain: {
              chainId: 12345,
              domainId: 12345,
              name: 'testchain',
              protocol: ProtocolType.Ethereum,
              rpcUrls: [{ http: 'https://testchain.example.com' }],
              blockExplorers: c.blockExplorers,
            },
          });

          const result = chainManager.tryGetEvmExplorerMetadata('testchain');

          if (c.expectedFamily === null) {
            expect(result).to.equal(null);
          } else {
            expect(result?.family).to.equal(c.expectedFamily);
          }
        });
      }
    },
  );
});
