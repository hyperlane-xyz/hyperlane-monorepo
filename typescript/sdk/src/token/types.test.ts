import { expect } from 'chai';

import { assert } from '@hyperlane-xyz/utils';

import { randomAddress } from '../test/testUtils.js';

import { TokenType } from './config.js';
import {
  CollateralTokenConfig,
  CollateralTokenConfigSchema,
  HypTokenConfig,
  HypTokenConfigSchema,
  NativeTokenConfigSchema,
  OpL1TokenConfig,
  OpL1TokenConfigSchema,
  OpL2TokenConfig,
  OpL2TokenConfigSchema,
  SyntheticTokenConfig,
  SyntheticTokenConfigSchema,
  TokenMetadata,
  TokenMetadataSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigSchema,
  WarpRouteDeployConfigSchemaErrors,
  XERC20LimitsTokenConfig,
  XERC20TokenConfigSchema,
} from './types.js';

describe('token schemas', () => {
  type TestCase<T> = {
    name: string;
    input: T;
  };

  describe('TokenMetadataSchema', () => {
    const validTestCases: TestCase<TokenMetadata>[] = [
      {
        name: 'minimal token metadata',
        input: {
          name: 'Test Token',
          symbol: 'TEST',
        },
      },
      {
        name: 'complete token metadata',
        input: {
          name: 'Test Token',
          symbol: 'TEST',
          decimals: 18,
          scale: 1,
          isNft: false,
          contractVersion: '1.0.0',
        },
      },
      {
        name: 'NFT token metadata',
        input: {
          name: 'Test NFT',
          symbol: 'TNFT',
          isNft: true,
        },
      },
      {
        name: 'token with high decimals',
        input: {
          name: 'High Precision Token',
          symbol: 'HPT',
          decimals: 36,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(TokenMetadataSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<TokenMetadata>>[] = [
      {
        name: 'missing name',
        input: { symbol: 'TEST' },
      },
      {
        name: 'missing symbol',
        input: { name: 'Test Token' },
      },
      {
        name: 'zero decimals',
        input: { name: 'Test Token', symbol: 'TEST', decimals: 0 },
      },
      {
        name: 'negative decimals',
        input: { name: 'Test Token', symbol: 'TEST', decimals: -1 },
      },
      {
        name: 'empty name',
        input: { name: '', symbol: 'TEST' },
      },
      {
        name: 'empty symbol',
        input: { name: 'Test Token', symbol: '' },
      },
      {
        name: 'non-string name',
        input: { name: 123 as any, symbol: 'TEST' },
      },
      {
        name: 'non-string symbol',
        input: { name: 'Test Token', symbol: 123 as any },
      },
      {
        name: 'non-number decimals',
        input: { name: 'Test Token', symbol: 'TEST', decimals: '18' as any },
      },
      {
        name: 'non-boolean isNft',
        input: { name: 'Test Token', symbol: 'TEST', isNft: 'true' as any },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(TokenMetadataSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('NativeTokenConfigSchema', () => {
    const validTestCases: TestCase<{
      type: TokenType.native | TokenType.nativeScaled;
      name?: string;
      symbol?: string;
      decimals?: number;
      allowedRebalancers?: string[];
    }>[] = [
      {
        name: 'minimal native token',
        input: {
          type: TokenType.native,
        },
      },
      {
        name: 'native scaled token',
        input: {
          type: TokenType.nativeScaled,
        },
      },
      {
        name: 'native token with metadata',
        input: {
          type: TokenType.native,
          name: 'Ethereum',
          symbol: 'ETH',
          decimals: 18,
        },
      },
      {
        name: 'native token with rebalancers',
        input: {
          type: TokenType.native,
          allowedRebalancers: ['0x1234567890123456789012345678901234567890'],
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(NativeTokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<unknown>[] = [
      {
        name: 'wrong token type',
        input: {
          type: TokenType.collateral,
        },
      },
      {
        name: 'missing type',
        input: {
          name: 'Ethereum',
          symbol: 'ETH',
        },
      },
      {
        name: 'invalid type value',
        input: {
          type: 'invalidType',
          name: 'Ethereum',
          symbol: 'ETH',
        },
      },
      {
        name: 'zero decimals',
        input: {
          type: TokenType.native,
          decimals: 0,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(NativeTokenConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('CollateralTokenConfigSchema', () => {
    const validTestCases: TestCase<CollateralTokenConfig>[] = [
      {
        name: 'minimal collateral token',
        input: {
          type: TokenType.collateral,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'collateral token with metadata',
        input: {
          type: TokenType.collateral,
          token: '0x1234567890123456789012345678901234567890',
          name: 'USDC',
          symbol: 'USDC',
          decimals: 6,
        },
      },
      {
        name: 'collateral vault token',
        input: {
          type: TokenType.collateralVault,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'collateral fiat token',
        input: {
          type: TokenType.collateralFiat,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'collateral URI token',
        input: {
          type: TokenType.collateralUri,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(CollateralTokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<CollateralTokenConfig>>[] = [
      {
        name: 'missing token address',
        input: {
          type: TokenType.collateral,
        },
      },
      {
        name: 'wrong token type',
        input: {
          type: TokenType.native as any,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty token address',
        input: {
          type: TokenType.collateral,
          token: '',
        },
      },
      {
        name: 'non-string token address',
        input: {
          type: TokenType.collateral,
          token: 123 as any,
        },
      },
      {
        name: 'zero decimals',
        input: {
          type: TokenType.collateral,
          token: '0x1234567890123456789012345678901234567890',
          decimals: 0,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(CollateralTokenConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });
  });

  describe('SyntheticTokenConfigSchema', () => {
    const validTestCases: TestCase<SyntheticTokenConfig>[] = [
      {
        name: 'minimal synthetic token',
        input: {
          type: TokenType.synthetic,
        },
      },
      {
        name: 'synthetic token with metadata',
        input: {
          type: TokenType.synthetic,
          name: 'Synthetic USDC',
          symbol: 'synUSDC',
          decimals: 6,
          initialSupply: '1000000',
        },
      },
      {
        name: 'synthetic URI token',
        input: {
          type: TokenType.syntheticUri,
          initialSupply: 1000000,
        },
      },
      {
        name: 'synthetic token with string supply',
        input: {
          type: TokenType.synthetic,
          initialSupply: '999999999999999999999',
        },
      },
      {
        name: 'synthetic token with number supply',
        input: {
          type: TokenType.synthetic,
          initialSupply: 1000000,
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(SyntheticTokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<SyntheticTokenConfig>>[] = [
      {
        name: 'wrong token type',
        input: {
          type: TokenType.collateral as any,
        },
      },
      {
        name: 'missing type',
        input: {
          name: 'Synthetic Token',
          symbol: 'SYN',
        },
      },
      {
        name: 'invalid type value',
        input: {
          type: 'invalidSyntheticType' as any,
          name: 'Synthetic Token',
          symbol: 'SYN',
        },
      },
      {
        name: 'zero decimals',
        input: {
          type: TokenType.synthetic,
          decimals: 0,
        },
      },
      {
        name: 'boolean initialSupply',
        input: {
          type: TokenType.synthetic,
          initialSupply: true as any,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(SyntheticTokenConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('OpL2TokenConfigSchema', () => {
    const validTestCases: TestCase<OpL2TokenConfig>[] = [
      {
        name: 'minimal OP L2 token',
        input: {
          type: TokenType.nativeOpL2,
          l2Bridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'OP L2 token with metadata',
        input: {
          type: TokenType.nativeOpL2,
          l2Bridge: '0x1234567890123456789012345678901234567890',
          name: 'Optimism ETH',
          symbol: 'ETH',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(OpL2TokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<OpL2TokenConfig>>[] = [
      {
        name: 'missing l2Bridge',
        input: {
          type: TokenType.nativeOpL2,
        },
      },
      {
        name: 'wrong token type',
        input: {
          type: TokenType.native as any,
          l2Bridge: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty l2Bridge',
        input: {
          type: TokenType.nativeOpL2,
          l2Bridge: '',
        },
      },
      {
        name: 'non-string l2Bridge',
        input: {
          type: TokenType.nativeOpL2,
          l2Bridge: 123 as any,
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(OpL2TokenConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('OpL1TokenConfigSchema', () => {
    const validTestCases: TestCase<OpL1TokenConfig>[] = [
      {
        name: 'minimal OP L1 token',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          version: 1,
          urls: ['https://example.com'],
        },
      },
      {
        name: 'OP L1 token with metadata',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          version: 1,
          urls: ['https://example.com'],
          name: 'Ethereum',
          symbol: 'ETH',
        },
      },
      {
        name: 'OP L1 token with multiple URLs',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          version: 2,
          urls: ['https://example.com', 'https://backup.com'],
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(OpL1TokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<OpL1TokenConfig>>[] = [
      {
        name: 'missing portal',
        input: {
          type: TokenType.nativeOpL1,
          version: 1,
          urls: ['https://example.com'],
        },
      },
      {
        name: 'missing version',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          urls: ['https://example.com'],
        },
      },
      {
        name: 'missing urls',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          version: 1,
        },
      },
      {
        name: 'empty urls array',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          version: 1,
          urls: [],
        },
      },
      {
        name: 'non-number version',
        input: {
          type: TokenType.nativeOpL1,
          portal: '0x1234567890123456789012345678901234567890',
          version: '1' as any,
          urls: ['https://example.com'],
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(OpL1TokenConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('XERC20TokenConfigSchema', () => {
    const validTestCases: TestCase<XERC20LimitsTokenConfig>[] = [
      {
        name: 'minimal XERC20 token',
        input: {
          type: TokenType.XERC20,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'XERC20 lockbox token',
        input: {
          type: TokenType.XERC20Lockbox,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'XERC20 token with limits',
        input: {
          type: TokenType.XERC20,
          token: '0x1234567890123456789012345678901234567890',
          xERC20: {
            warpRouteLimits: {
              bufferCap: '1000000',
              rateLimitPerSecond: '1000',
            },
          },
        },
      },
      {
        name: 'XERC20 token with extra bridges',
        input: {
          type: TokenType.XERC20,
          token: '0x1234567890123456789012345678901234567890',
          xERC20: {
            extraBridges: [
              {
                lockbox: '0x1234567890123456789012345678901234567890',
                limits: {
                  bufferCap: '500000',
                  rateLimitPerSecond: '500',
                },
              },
            ],
            warpRouteLimits: {
              bufferCap: '1000000',
              rateLimitPerSecond: '1000',
            },
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(XERC20TokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<XERC20LimitsTokenConfig>>[] = [
      {
        name: 'missing token address',
        input: {
          type: TokenType.XERC20,
        },
      },
      {
        name: 'wrong token type',
        input: {
          type: TokenType.native as any,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'empty token address',
        input: {
          type: TokenType.XERC20,
          token: '',
        },
      },
      {
        name: 'invalid type value',
        input: {
          type: 'invalidXERC20Type',
          token: '0x1234567890123456789012345678901234567890',
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(XERC20TokenConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('HypTokenConfigSchema', () => {
    const validTestCases: TestCase<HypTokenConfig>[] = [
      {
        name: 'native token config',
        input: {
          type: TokenType.native,
          name: 'Ethereum',
          symbol: 'ETH',
        },
      },
      {
        name: 'collateral token config',
        input: {
          type: TokenType.collateral,
          token: '0x1234567890123456789012345678901234567890',
          name: 'USDC',
          symbol: 'USDC',
        },
      },
      {
        name: 'synthetic token config',
        input: {
          type: TokenType.synthetic,
          name: 'Synthetic USDC',
          symbol: 'synUSDC',
        },
      },
      {
        name: 'XERC20 token config',
        input: {
          type: TokenType.XERC20,
          token: '0x1234567890123456789012345678901234567890',
        },
      },
      {
        name: 'OP L2 token config',
        input: {
          type: TokenType.nativeOpL2,
          l2Bridge: '0x1234567890123456789012345678901234567890',
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(HypTokenConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<HypTokenConfig>>[] = [
      {
        name: 'missing type',
        input: {
          name: 'Token',
          symbol: 'TOK',
        },
      },
      {
        name: 'invalid type',
        input: {
          type: 'invalidType' as any,
          name: 'Token',
          symbol: 'TOK',
        },
      },
      {
        name: 'collateral without token address',
        input: {
          type: TokenType.collateral,
          name: 'USDC',
          symbol: 'USDC',
        },
      },
      {
        name: 'OP L2 without l2Bridge',
        input: {
          type: TokenType.nativeOpL2,
          name: 'Optimism ETH',
          symbol: 'ETH',
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(HypTokenConfigSchema.safeParse(input).success).to.be.false;
      });
    });
  });

  describe('WarpRouteDeployConfigSchema refine', () => {
    const SOME_ADDRESS = randomAddress();
    const COLLATERAL_TYPES = [
      TokenType.collateral,
      TokenType.collateralUri,
      TokenType.collateralVault,
    ];
    const NON_COLLATERAL_TYPES = [TokenType.synthetic, TokenType.syntheticUri];

    const validTestCases: TestCase<WarpRouteDeployConfig>[] = [
      {
        name: 'basic collateral config',
        input: {
          arbitrum: {
            type: TokenType.collateral,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
        },
      },
      {
        name: 'config without mailbox address',
        input: {
          arbitrum: {
            type: TokenType.collateral,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
          },
        },
      },
      {
        name: 'non-collateral type with metadata',
        input: {
          arbitrum: {
            type: TokenType.synthetic,
            name: 'name',
            symbol: 'symbol',
            owner: SOME_ADDRESS,
          },
        },
      },
      {
        name: 'rebasing collateral with synthetic rebase',
        input: {
          arbitrum: {
            type: TokenType.collateralVaultRebase,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
          ethereum: {
            type: TokenType.syntheticRebase,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
            collateralChainName: '',
          },
        },
      },
      {
        name: 'multiple synthetic rebase with collateral chain derivation',
        input: {
          arbitrum: {
            type: TokenType.collateralVaultRebase,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
          ethereum: {
            type: TokenType.syntheticRebase,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
            collateralChainName: '',
          },
          optimism: {
            type: TokenType.syntheticRebase,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
            collateralChainName: '',
          },
        },
      },
    ];

    validTestCases.forEach(({ name, input }) => {
      it(`should accept ${name}`, () => {
        expect(WarpRouteDeployConfigSchema.safeParse(input).success).to.be.true;
      });
    });

    const invalidTestCases: TestCase<Partial<WarpRouteDeployConfig>>[] = [
      {
        name: 'config missing token type',
        input: {
          arbitrum: {
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          } as any,
        },
      },
      {
        name: 'collateral config missing token address',
        input: {
          arbitrum: {
            type: TokenType.collateral,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          } as any,
        },
      },
      {
        name: 'non-collateral type missing symbol',
        input: {
          arbitrum: {
            type: TokenType.synthetic,
            name: 'name',
            owner: SOME_ADDRESS,
          },
        },
      },
      {
        name: 'rebasing collateral with non-synthetic rebase',
        input: {
          arbitrum: {
            type: TokenType.collateralVaultRebase,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
          ethereum: {
            type: TokenType.collateralVault,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
          optimism: {
            type: TokenType.syntheticRebase,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
            collateralChainName: '',
          },
        },
      },
      {
        name: 'only collateral vault rebase',
        input: {
          arbitrum: {
            type: TokenType.collateralVaultRebase,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
        },
      },
      {
        name: 'multiple collateral vault rebase',
        input: {
          arbitrum: {
            type: TokenType.collateralVaultRebase,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
          ethereum: {
            type: TokenType.collateralVaultRebase,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
        },
      },
    ];

    invalidTestCases.forEach(({ name, input }) => {
      it(`should reject ${name}`, () => {
        expect(WarpRouteDeployConfigSchema.safeParse(input).success).to.be
          .false;
      });
    });

    it('should throw specific error for rebasing collateral with non-synthetic rebase', () => {
      const config = {
        arbitrum: {
          type: TokenType.collateralVaultRebase,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        ethereum: {
          type: TokenType.collateralVault,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        optimism: {
          type: TokenType.syntheticRebase,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          collateralChainName: '',
        },
      };
      const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
      assert(!parseResults.success, 'must be false');
      expect(parseResults.error.issues[0].message).to.equal(
        WarpRouteDeployConfigSchemaErrors.ONLY_SYNTHETIC_REBASE,
      );
    });

    it('should derive collateral chain name for synthetic rebase', () => {
      const config = {
        arbitrum: {
          type: TokenType.collateralVaultRebase,
          token: SOME_ADDRESS,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
        },
        ethereum: {
          type: TokenType.syntheticRebase,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          collateralChainName: '',
        },
        optimism: {
          type: TokenType.syntheticRebase,
          owner: SOME_ADDRESS,
          mailbox: SOME_ADDRESS,
          collateralChainName: '',
        },
      };
      const parseResults = WarpRouteDeployConfigSchema.safeParse(config);
      assert(parseResults.success, 'must be true');
      const warpConfig: WarpRouteDeployConfig = parseResults.data;

      assert(
        warpConfig.optimism.type === TokenType.syntheticRebase,
        'must be syntheticRebase',
      );
      expect(warpConfig.optimism.collateralChainName).to.equal('arbitrum');
    });

    it('should handle collateral types requiring token address', () => {
      for (const type of COLLATERAL_TYPES) {
        const configWithToken = {
          arbitrum: {
            type,
            token: SOME_ADDRESS,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
        };
        expect(WarpRouteDeployConfigSchema.safeParse(configWithToken).success)
          .to.be.true;

        const configWithoutToken = {
          arbitrum: {
            type,
            owner: SOME_ADDRESS,
            mailbox: SOME_ADDRESS,
          },
        };
        expect(
          WarpRouteDeployConfigSchema.safeParse(configWithoutToken).success,
        ).to.be.false;
      }
    });

    it('should handle non-collateral types requiring metadata', () => {
      for (const type of NON_COLLATERAL_TYPES) {
        const configWithMetadata = {
          arbitrum: {
            type,
            name: 'name',
            symbol: 'symbol',
            owner: SOME_ADDRESS,
          },
        };
        expect(
          WarpRouteDeployConfigSchema.safeParse(configWithMetadata).success,
        ).to.be.true;

        const configWithoutSymbol = {
          arbitrum: {
            type,
            name: 'name',
            owner: SOME_ADDRESS,
          },
        };
        expect(
          WarpRouteDeployConfigSchema.safeParse(configWithoutSymbol).success,
        ).to.be.false;
      }
    });
  });

  describe('Edge cases and schema composition', () => {
    it('should handle optional fields correctly', () => {
      const minimalNative = {
        type: TokenType.native,
      };

      expect(NativeTokenConfigSchema.safeParse(minimalNative).success).to.be
        .true;
    });

    it('should validate discriminated union correctly', () => {
      const configs = [
        { type: TokenType.native },
        {
          type: TokenType.collateral,
          token: '0x1234567890123456789012345678901234567890',
        },
        { type: TokenType.synthetic },
        {
          type: TokenType.XERC20,
          token: '0x1234567890123456789012345678901234567890',
        },
      ];

      configs.forEach((config) => {
        expect(HypTokenConfigSchema.safeParse(config).success).to.be.true;
      });
    });

    it('should handle complex nested xERC20 configuration', () => {
      const complexXERC20 = {
        type: TokenType.XERC20,
        token: '0x1234567890123456789012345678901234567890',
        name: 'Cross-Chain Token',
        symbol: 'CCT',
        decimals: 18,
        xERC20: {
          extraBridges: [
            {
              lockbox: '0x1234567890123456789012345678901234567890',
              limits: {
                bufferCap: '1000000000000000000000',
                rateLimitPerSecond: '1000000000000000000',
              },
            },
          ],
          warpRouteLimits: {
            bufferCap: '5000000000000000000000',
            rateLimitPerSecond: '5000000000000000000',
          },
        },
      };

      expect(XERC20TokenConfigSchema.safeParse(complexXERC20).success).to.be
        .true;
    });
  });
});
