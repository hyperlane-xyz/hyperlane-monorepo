import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  BlockExplorer,
  BlockExplorerSchema,
  ChainDisabledReason,
  ChainMetadata,
  ChainMetadataSchema,
  ChainStatus,
  ChainTechnicalStack,
  DisabledChainSchema,
  EnabledChainSchema,
  ExplorerFamily,
  GasPriceSchema,
  NativeToken,
  NativeTokenSchema,
  RpcUrl,
  RpcUrlSchema,
} from './chainMetadataTypes.js';

describe('chainMetadataTypes', () => {
  type TestCase<T> = {
    name: string;
    input: T;
  };

  const baseValidChain = {
    domainId: 1,
    chainId: 1,
    name: 'ethereum',
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'https://rpc.example.com' }],
    nativeToken: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
  };

  describe('RpcUrlSchema', () => {
    const validTestCases: TestCase<RpcUrl>[] = [
      {
        name: 'minimal valid RPC URL',
        input: {
          http: 'https://rpc.example.com',
        },
      },
      {
        name: 'complete RPC URL with all optional fields',
        input: {
          http: 'https://rpc.example.com',
          concurrency: 10,
          webSocket: 'wss://ws.example.com',
          pagination: {
            maxBlockRange: 1000,
            minBlockNumber: 0,
            maxBlockAge: 100,
          },
          retry: {
            maxRequests: 3,
            baseRetryMs: 1000,
          },
          public: true,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(RpcUrlSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<RpcUrl>[] = [
      { name: 'empty HTTP URL', input: { http: '' } },
      { name: 'invalid HTTP URL', input: { http: 'invalid-url' } },
      { name: 'HTTP URL with spaces', input: { http: 'not a url' } },
      {
        name: 'negative concurrency',
        input: { http: 'https://rpc.example.com', concurrency: -1 },
      },
      {
        name: 'zero concurrency',
        input: { http: 'https://rpc.example.com', concurrency: 0 },
      },
      {
        name: 'invalid pagination maxBlockRange',
        input: {
          http: 'https://rpc.example.com',
          pagination: { maxBlockRange: 0 },
        },
      },
      {
        name: 'invalid pagination minBlockNumber',
        input: {
          http: 'https://rpc.example.com',
          pagination: { minBlockNumber: -1 },
        },
      },
      {
        name: 'invalid pagination maxBlockAge',
        input: {
          http: 'https://rpc.example.com',
          pagination: { maxBlockAge: 0 },
        },
      },
      {
        name: 'invalid retry maxRequests',
        input: {
          http: 'https://rpc.example.com',
          retry: { maxRequests: 0, baseRetryMs: 1000 },
        },
      },
      {
        name: 'invalid retry baseRetryMs',
        input: {
          http: 'https://rpc.example.com',
          retry: { maxRequests: 3, baseRetryMs: 0 },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(RpcUrlSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('BlockExplorerSchema', () => {
    const validTestCases: TestCase<BlockExplorer>[] = [
      {
        name: 'minimal valid block explorer',
        input: {
          name: 'Etherscan',
          url: 'https://etherscan.io',
          apiUrl: 'https://api.etherscan.io',
        },
      },
      {
        name: 'complete block explorer with all optional fields',
        input: {
          name: 'Etherscan',
          url: 'https://etherscan.io',
          apiUrl: 'https://api.etherscan.io',
          apiKey: 'your-api-key',
          family: ExplorerFamily.Etherscan,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(BlockExplorerSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<BlockExplorer>[] = [
      {
        name: 'invalid main URL',
        input: {
          name: 'Explorer',
          url: 'not-a-url',
          apiUrl: 'https://api.example.com',
        },
      },
      {
        name: 'invalid API URL',
        input: {
          name: 'Explorer',
          url: 'https://example.com',
          apiUrl: 'not-a-url',
        },
      },
      {
        name: 'invalid explorer family',
        input: {
          name: 'Explorer',
          url: 'https://example.com',
          apiUrl: 'https://api.example.com',
          // Type asserting to trigger validation error
          family: 'invalid-family' as ExplorerFamily,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(BlockExplorerSchema.safeParse(input).success).to.be.false;
      });
    });

    it('should accept all valid explorer families', () => {
      Object.values(ExplorerFamily).forEach((family) => {
        const input: BlockExplorer = {
          name: 'Explorer',
          url: 'https://example.com',
          apiUrl: 'https://api.example.com',
          family,
        };

        expect(BlockExplorerSchema.safeParse(input).success).to.be.true;
      });
    });
  });

  describe('NativeTokenSchema', () => {
    const validTestCases: TestCase<NativeToken>[] = [
      {
        name: 'valid native token',
        input: {
          name: 'Ether',
          symbol: 'ETH',
          decimals: 18,
        },
      },
      {
        name: 'native token with denom',
        input: {
          name: 'Cosmos',
          symbol: 'ATOM',
          decimals: 6,
          denom: 'uatom',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(NativeTokenSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<NativeToken>>[] = [
      {
        name: 'negative decimals',
        input: { name: 'Token', symbol: 'TKN', decimals: -1 },
      },
      {
        name: 'decimals too large',
        input: { name: 'Token', symbol: 'TKN', decimals: 256 },
      },
      {
        name: 'decimal decimals',
        input: { name: 'Token', symbol: 'TKN', decimals: 3.14 },
      },
      {
        name: 'missing name',
        input: { symbol: 'TKN', decimals: 18 },
      },
      {
        name: 'missing symbol',
        input: { name: 'Token', decimals: 18 },
      },
      {
        name: 'missing decimals',
        input: { name: 'Token', symbol: 'TKN' },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(NativeTokenSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('GasPriceSchema', () => {
    const validTestCases: TestCase<ChainMetadata['gasPrice']>[] = [
      {
        name: 'valid gas price',
        input: {
          denom: 'uatom',
          amount: '1000000',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(GasPriceSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<ChainMetadata['gasPrice']>>[] = [
      {
        name: 'missing denom',
        input: { amount: '1000000' },
      },
      {
        name: 'missing amount',
        input: { denom: 'uatom' },
      },
      // Type asserting to trigger validation error
      {
        name: 'non-string denom',
        input: { denom: 123 as unknown as string, amount: '1000000' },
      },
      {
        name: 'non-string amount',
        input: { denom: 'uatom', amount: 1000000 as unknown as string },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(GasPriceSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('DisabledChainSchema', () => {
    const validTestCases: TestCase<{
      status: ChainStatus.Disabled;
      reasons: ChainDisabledReason[];
    }>[] = [
      {
        name: 'valid disabled chain',
        input: {
          status: ChainStatus.Disabled,
          reasons: [ChainDisabledReason.BadRpc],
        },
      },
      {
        name: 'disabled chain with multiple reasons',
        input: {
          status: ChainStatus.Disabled,
          reasons: [ChainDisabledReason.BadRpc, ChainDisabledReason.Deprecated],
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(DisabledChainSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<{
      status: ChainStatus;
      reasons: ChainDisabledReason[];
    }>[] = [
      {
        name: 'wrong status',
        input: {
          status: ChainStatus.Live,
          reasons: [ChainDisabledReason.BadRpc],
        },
      },
      {
        name: 'empty reasons array',
        input: {
          status: ChainStatus.Disabled,
          reasons: [],
        },
      },
      {
        name: 'invalid reasons',
        input: {
          status: ChainStatus.Disabled,
          reasons: ['invalid-reason' as ChainDisabledReason],
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(DisabledChainSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('EnabledChainSchema', () => {
    const validTestCases: TestCase<{ status: ChainStatus.Live }>[] = [
      {
        name: 'valid enabled chain',
        input: {
          status: ChainStatus.Live,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(EnabledChainSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'wrong status',
        input: {
          status: ChainStatus.Disabled,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(EnabledChainSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('ChainMetadataSchema', () => {
    const validTestCases: TestCase<ChainMetadata>[] = [
      {
        name: 'minimal valid chain metadata',
        input: {
          domainId: 1,
          chainId: 1,
          name: 'ethereum',
          protocol: ProtocolType.Ethereum,
          rpcUrls: [{ http: 'https://rpc.example.com' }],
        },
      },
      {
        name: 'complete chain metadata with all optional fields',
        input: {
          domainId: 1,
          name: 'ethereum',
          protocol: ProtocolType.Ethereum,
          rpcUrls: [
            {
              http: 'https://rpc.example.com',
              concurrency: 10,
              webSocket: 'wss://ws.example.com',
            },
          ],
          chainId: 1,
          nativeToken: {
            name: 'Ether',
            symbol: 'ETH',
            decimals: 18,
          },
          availability: {
            status: ChainStatus.Live,
          },
          bech32Prefix: 'eth',
          blockExplorers: [
            {
              name: 'Etherscan',
              url: 'https://etherscan.io',
              apiUrl: 'https://api.etherscan.io',
              family: ExplorerFamily.Etherscan,
            },
          ],
          blocks: {
            confirmations: 1,
            reorgPeriod: 7,
            estimateBlockTime: 12000,
          },
          technicalStack: ChainTechnicalStack.Other,
          displayName: 'Ethereum Mainnet',
          isTestnet: false,
          logoURI: 'https://example.com/logo.png',
        },
      },
      {
        name: 'chain with enabled availability',
        input: {
          ...baseValidChain,
          availability: {
            status: ChainStatus.Live,
          },
        },
      },
      {
        name: 'chain with disabled availability',
        input: {
          ...baseValidChain,
          availability: {
            status: ChainStatus.Disabled,
            reasons: [ChainDisabledReason.BadRpc],
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(ChainMetadataSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<ChainMetadata>[] = [
      {
        name: 'invalid chain name',
        input: {
          ...baseValidChain,
          name: 'Invalid-Chain',
        },
      },
      {
        name: 'invalid protocol type',
        input: {
          ...baseValidChain,
          // Type asserting to trigger the error
          protocol: 'invalid-protocol' as ProtocolType,
        },
      },
      {
        name: 'empty rpcUrls array',
        input: {
          ...baseValidChain,
          rpcUrls: [],
        },
      },
      {
        name: 'invalid block configuration',
        input: {
          ...baseValidChain,
          blocks: {
            confirmations: -1, // Invalid
            estimateBlockTime: 12000,
          },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(ChainMetadataSchema.safeParse(input).success).to.be.false;
      });
    });

    it('should accept various technical stacks', () => {
      Object.values(ChainTechnicalStack).forEach((stack) => {
        const chainWithStack: ChainMetadata = {
          ...baseValidChain,
          technicalStack: stack,
          index:
            stack === ChainTechnicalStack.ArbitrumNitro
              ? { from: 100 }
              : undefined,
        };

        expect(ChainMetadataSchema.safeParse(chainWithStack).success).to.be
          .true;
      });
    });
  });

  describe('Schema composition and advanced validation', () => {
    const validTestCases: TestCase<ChainMetadata>[] = [
      {
        name: 'nested objects',
        input: {
          ...baseValidChain,
          rpcUrls: [
            {
              http: 'https://rpc.example.com',
              pagination: {
                maxBlockRange: 1000,
                minBlockNumber: 0,
              },
            },
          ],
          blockExplorers: [
            {
              name: 'Etherscan',
              url: 'https://etherscan.io',
              apiUrl: 'https://api.etherscan.io',
              family: ExplorerFamily.Etherscan,
            },
          ],
        },
      },
      {
        name: 'array validation',
        input: {
          ...baseValidChain,
          rpcUrls: [
            { http: 'https://rpc1.example.com' },
            { http: 'https://rpc2.example.com' },
          ],
          blockExplorers: [
            {
              name: 'Etherscan',
              url: 'https://etherscan.io',
              apiUrl: 'https://api.etherscan.io',
            },
            {
              name: 'Blockscout',
              url: 'https://blockscout.com',
              apiUrl: 'https://blockscout.com/api',
              family: ExplorerFamily.Blockscout,
            },
          ],
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should validate ${name} correctly`, () => {
        expect(ChainMetadataSchema.safeParse(input).success).to.be.true;
      });
    });

    it('should provide detailed error messages', () => {
      const invalidChain = {
        ...baseValidChain,
        chainId: 'invalid', // Should be number for Ethereum
      };

      const result = ChainMetadataSchema.safeParse(invalidChain);
      expect(result.success).to.be.false;
      if (!result.success) {
        expect(result.error.issues.length).to.be.greaterThan(0);
        expect(result.error.issues[0].path).to.include('chainId');
      }
    });
  });

  describe('Edge cases and error handling', () => {
    type EdgeCaseTestCase = {
      name: string;
      input: ChainMetadata;
      expectedSuccess: boolean;
    };

    const edgeCaseTestCases: EdgeCaseTestCase[] = [
      {
        name: 'undefined input',
        input: undefined as any,
        expectedSuccess: false,
      },
      { name: 'null input', input: null as any, expectedSuccess: false },
      { name: 'empty object', input: {} as any, expectedSuccess: false },
      {
        name: 'invalid arbitrum nitro chain configuration when indexing config is missing',
        input: {
          ...baseValidChain,
          technicalStack: ChainTechnicalStack.ArbitrumNitro,
        },
        expectedSuccess: false,
      },
      {
        name: 'empty arrays in allowed contexts',
        input: {
          ...baseValidChain,
          blockExplorers: [], // Empty array should be allowed
        },
        expectedSuccess: true,
      },
      {
        name: 'large numbers',
        input: {
          ...baseValidChain,
          domainId: Number.MAX_SAFE_INTEGER,
          chainId: Number.MAX_SAFE_INTEGER,
          nativeToken: {
            name: 'Ether',
            symbol: 'ETH',
            decimals: 255, // Maximum allowed
          },
          blocks: {
            confirmations: Number.MAX_SAFE_INTEGER,
            estimateBlockTime: Number.MAX_SAFE_INTEGER,
          },
        },
        expectedSuccess: true,
      },
    ];

    edgeCaseTestCases.forEach(({ name, input, expectedSuccess }) => {
      it(`should handle ${name} correctly`, () => {
        expect(ChainMetadataSchema.safeParse(input).success).to.equal(
          expectedSuccess,
        );
      });
    });
  });
});
