import { expect } from 'chai';
import { constants } from 'ethers';

import {
  DEFAULT_ROUTER_KEY,
  ResolvedCrossCollateralRoutingFeeConfigInput,
  ResolvedLinearFeeConfigInput,
  ResolvedRoutingFeeConfigInput,
  TokenFeeType,
} from '../fee/types.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import type { WarpCoreConfig } from '../warp/types.js';

import { TokenType } from './config.js';
import {
  filterWarpCoreConfigMapByChains,
  getChainsFromWarpCoreConfig,
  resolveTokenFeeAddress,
  transformConfigToCheck,
  warpCoreConfigMatchesChains,
} from './configUtils.js';
import { TokenStandard } from './TokenStandard.js';
import { HypTokenConfig } from './types.js';

describe('configUtils', () => {
  describe(transformConfigToCheck.name, () => {
    const ADDRESS = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';

    const testCases: Array<{
      msg: string;
      expected: any;
      input: any;
    }> = [
      {
        msg: 'It should remove the address and ownerOverrides fields from the config',
        input: {
          ownerOverrides: {
            owner: ADDRESS,
          },
          hook: {
            type: HookType.AMOUNT_ROUTING,
            address: ADDRESS,
          },
          interchainSecurityModule: {
            type: IsmType.AGGREGATION,
            address: ADDRESS,
            modules: [
              {
                type: IsmType.AMOUNT_ROUTING,
                address: ADDRESS,
              },
              {
                type: IsmType.FALLBACK_ROUTING,
                address: ADDRESS,
              },
            ],
          },
        },
        expected: {
          hook: {
            type: HookType.AMOUNT_ROUTING,
          },
          interchainSecurityModule: {
            type: IsmType.AGGREGATION,
            modules: [
              {
                type: IsmType.AMOUNT_ROUTING,
              },
              {
                type: IsmType.FALLBACK_ROUTING,
              },
            ],
          },
          scale: { numerator: 1n, denominator: 1n },
        },
      },
      {
        msg: 'It should not remove the address property from the remoteRouters object',
        input: {
          interchainSecurityModule: {
            address: ADDRESS,
            type: 'NULL',
          },
          remoteRouters: {
            '1': {
              address: ADDRESS,
            },
          },
        },
        expected: {
          interchainSecurityModule: {
            type: 'NULL',
          },
          remoteRouters: {
            '1': {
              address: ADDRESS,
            },
          },
          scale: { numerator: 1n, denominator: 1n },
        },
      },
      {
        msg: 'It should preserve the proxyAdmin address property for explicit checks',
        input: {
          hook: {
            address: ADDRESS,
            type: HookType.MERKLE_TREE,
          },
          proxyAdmin: {
            address: ADDRESS,
            owner: ADDRESS,
          },
        },
        expected: {
          hook: {
            type: HookType.MERKLE_TREE,
          },
          proxyAdmin: {
            address: ADDRESS,
            owner: ADDRESS,
          },
          scale: { numerator: 1n, denominator: 1n },
        },
      },
      {
        msg: 'It should sort out of order modules and validator arrays',
        expected: {
          bsc: {
            decimals: 6,
            interchainSecurityModule: {
              type: 'defaultFallbackRoutingIsm',
              owner: '0xe472f601aeeebeafbbd3a6fd9a788966011ad1df',
              domains: {
                milkyway: {
                  threshold: '1',
                  modules: [
                    {
                      threshold: 3,
                      type: 'merkleRootMultisigIsm',
                      validators: [
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                    {
                      threshold: 3,
                      type: 'messageIdMultisigIsm',
                      validators: [
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                  ],
                },
              },
            },
            name: 'MilkyWay',
            owner: '0xe472f601aeeebeafbbd3a6fd9a788966011ad1df',
            symbol: 'MILK',
            type: 'synthetic',
          },
          milkyway: {
            foreignDeployment:
              '0x726f757465725f61707000000000000000000000000000010000000000000000',
            owner: 'milk169dcaz397j75tjfpl6ykm23dfrv39dqd58lsag',
            type: 'native',
          },
          scale: { numerator: 1n, denominator: 1n },
        },
        input: {
          bsc: {
            decimals: 6,
            interchainSecurityModule: {
              type: 'defaultFallbackRoutingIsm',
              owner: '0xE472F601aeEeBEafbbd3a6FD9A788966011AD1Df',
              domains: {
                milkyway: {
                  threshold: '1',
                  modules: [
                    {
                      threshold: 3,
                      type: 'messageIdMultisigIsm',
                      validators: [
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                    {
                      threshold: 3,
                      type: 'merkleRootMultisigIsm',
                      validators: [
                        '0x9985e0c6df8e25b655b46a317af422f5e7756875',
                        '0x55010624d5e239281d0850dc7915b78187e8bc0e',
                        '0x9ecf299947b030f9898faf328e5edbf77b13e974',
                        '0x56fa9ac314ad49836ffb35918043d6b2dec304fb',
                        '0xb69c0d1aacd305edeca88b482b9dd9657f3a8b5c',
                      ],
                    },
                  ],
                },
              },
            },
            name: 'MilkyWay',
            owner: '0xE472F601aeEeBEafbbd3a6FD9A788966011AD1Df',
            symbol: 'MILK',
            type: 'synthetic',
          },
          milkyway: {
            foreignDeployment:
              '0x726f757465725f61707000000000000000000000000000010000000000000000',
            owner: 'milk169dcaz397j75tjfpl6ykm23dfrv39dqd58lsag',
            type: 'native',
          },
        },
      },
    ];

    for (const { msg, input, expected } of testCases) {
      it(msg, () => {
        const transformedObj = transformConfigToCheck(input);

        expect(transformedObj).to.eql(expected);
      });
    }

    it('normalizes LinearFee maxFee/halfAmount so equivalent bps configs compare equal', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
          maxFee: 999n,
          halfAmount: 123n,
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
        },
      });
    });

    it('normalizes OffchainQuotedLinearFee maxFee/halfAmount so equivalent bps configs compare equal', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
          maxFee: 999n,
          halfAmount: 123n,
          quoteSigners: [ADDRESS],
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          owner: ADDRESS,
          token: ADDRESS,
          bps: 300n,
          quoteSigners: [ADDRESS],
        },
      });
    });

    it('normalizes RoutingFee maxFee/halfAmount recursively for feeContracts', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          maxFee: 1n,
          halfAmount: 2n,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: ADDRESS,
              token: ADDRESS,
              bps: 300n,
              maxFee: 3n,
              halfAmount: 4n,
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: ADDRESS,
              token: ADDRESS,
              bps: 300n,
            },
          },
        },
      });
    });

    it('normalizes CCRF router-keyed fee contracts recursively', () => {
      const ROUTER_KEY =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 200n,
                maxFee: 3n,
                halfAmount: 4n,
              },
              [ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 300n,
                maxFee: 5n,
                halfAmount: 6n,
              },
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 200n,
              },
              [ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 300n,
              },
            },
          },
        },
      });
    });

    it('keeps only populated CCRF router entries during normalization', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 200n,
              },
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ADDRESS,
          feeContracts: {
            ethereum: {
              [DEFAULT_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                owner: ADDRESS,
                token: ADDRESS,
                bps: 200n,
              },
            },
          },
        },
      });
    });

    it('normalizes RoutingFee feeContracts when both destination and nested fee contracts are provided', () => {
      const transformedObj = transformConfigToCheck({
        type: TokenType.collateral,
        token: ADDRESS,
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: ADDRESS,
              token: ADDRESS,
              bps: 100n,
            },
          },
        },
      } as any);

      expect(transformedObj).to.eql({
        type: TokenType.collateral,
        token: ADDRESS,
        scale: { numerator: 1n, denominator: 1n },
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ADDRESS,
          token: ADDRESS,
          feeContracts: {
            ethereum: {
              type: TokenFeeType.LinearFee,
              owner: ADDRESS,
              token: ADDRESS,
              bps: 100n,
            },
          },
        },
      });
    });
  });

  describe(resolveTokenFeeAddress.name, () => {
    const ROUTER_ADDRESS = '0x1234567890123456789012345678901234567890';
    const OWNER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const COLLATERAL_TOKEN = '0x9999999999999999999999999999999999999999';

    const syntheticConfig: HypTokenConfig = {
      type: TokenType.synthetic,
    };

    const collateralConfig: HypTokenConfig = {
      type: TokenType.collateral,
      token: COLLATERAL_TOKEN,
    };

    const nativeConfig: HypTokenConfig = {
      type: TokenType.native,
    };

    it('should resolve token to router address for synthetic tokens', () => {
      const input = {
        type: TokenFeeType.LinearFee as const,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      ) as ResolvedLinearFeeConfigInput;

      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.owner).to.equal(OWNER_ADDRESS);
    });

    it('should resolve token to collateral address for collateral tokens', () => {
      const input = {
        type: TokenFeeType.LinearFee as const,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        collateralConfig,
      ) as ResolvedLinearFeeConfigInput;

      expect(result.token).to.equal(COLLATERAL_TOKEN);
    });

    it('should resolve token to AddressZero for native tokens', () => {
      const input = {
        type: TokenFeeType.LinearFee as const,
        owner: OWNER_ADDRESS,
        bps: 100,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        nativeConfig,
      ) as ResolvedLinearFeeConfigInput;

      expect(result.token).to.equal(constants.AddressZero);
    });

    it('should resolve nested feeContracts tokens for RoutingFee', () => {
      const input = {
        type: TokenFeeType.RoutingFee as const,
        owner: OWNER_ADDRESS,
        feeContracts: {
          ethereum: {
            type: TokenFeeType.LinearFee as const,
            owner: OWNER_ADDRESS,
            bps: 100,
          },
          arbitrum: {
            type: TokenFeeType.LinearFee as const,
            owner: OWNER_ADDRESS,
            bps: 50,
          },
        },
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      ) as ResolvedRoutingFeeConfigInput;

      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.type).to.equal(TokenFeeType.RoutingFee);

      const routingResult = result as ResolvedRoutingFeeConfigInput;
      expect(routingResult.feeContracts.ethereum.token).to.equal(
        ROUTER_ADDRESS,
      );
      expect(routingResult.feeContracts.arbitrum.token).to.equal(
        ROUTER_ADDRESS,
      );
    });

    it('should handle RoutingFee with empty feeContracts', () => {
      const input = {
        type: TokenFeeType.RoutingFee as const,
        owner: OWNER_ADDRESS,
        feeContracts: {},
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      ) as ResolvedRoutingFeeConfigInput;

      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.type).to.equal(TokenFeeType.RoutingFee);
    });

    it('should resolve token for nested cross collateral feeContracts', () => {
      const ROUTER_KEY =
        '0x1111111111111111111111111111111111111111111111111111111111111111';
      const input = {
        type: TokenFeeType.CrossCollateralRoutingFee as const,
        owner: OWNER_ADDRESS,
        feeContracts: {
          ethereum: {
            [DEFAULT_ROUTER_KEY]: {
              type: TokenFeeType.LinearFee as const,
              owner: OWNER_ADDRESS,
              bps: 100n,
            },
            [ROUTER_KEY]: {
              type: TokenFeeType.LinearFee as const,
              owner: OWNER_ADDRESS,
              bps: 200n,
            },
          },
        },
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      ) as ResolvedCrossCollateralRoutingFeeConfigInput;

      expect(result.feeContracts.ethereum[DEFAULT_ROUTER_KEY]?.token).to.equal(
        ROUTER_ADDRESS,
      );
      expect(result.feeContracts.ethereum[ROUTER_KEY]?.token).to.equal(
        ROUTER_ADDRESS,
      );
    });
  });

  const buildWarpCoreConfig = (chainNames: string[]): WarpCoreConfig => ({
    tokens: chainNames.map((chainName, index) => ({
      chainName,
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: `TKN${index + 1}`,
      name: `Token ${index + 1}`,
      addressOrDenom: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    })),
  });

  describe('getChainsFromWarpCoreConfig', () => {
    it('should return chain names from tokens', () => {
      const config = buildWarpCoreConfig(['ethereum', 'arbitrum', 'optimism']);

      const result = getChainsFromWarpCoreConfig(config);
      expect(result).to.deep.equal(['ethereum', 'arbitrum', 'optimism']);
    });

    it('should return empty array for empty tokens', () => {
      const config = buildWarpCoreConfig([]);
      const result = getChainsFromWarpCoreConfig(config);
      expect(result).to.deep.equal([]);
    });
  });

  describe('warpCoreConfigMatchesChains', () => {
    const config = buildWarpCoreConfig(['ethereum', 'arbitrum', 'optimism']);

    it('should return true when all chains are present', () => {
      expect(warpCoreConfigMatchesChains(config, ['ethereum', 'arbitrum'])).to
        .be.true;
    });

    it('should return true for single chain match', () => {
      expect(warpCoreConfigMatchesChains(config, ['optimism'])).to.be.true;
    });

    it('should return false when a chain is missing', () => {
      expect(warpCoreConfigMatchesChains(config, ['ethereum', 'polygon'])).to.be
        .false;
    });

    it('should return true for empty chains array', () => {
      expect(warpCoreConfigMatchesChains(config, [])).to.be.true;
    });
  });

  describe('filterWarpCoreConfigMapByChains', () => {
    const configMap: Record<string, WarpCoreConfig> = {
      'ETH/ethereum-arbitrum': buildWarpCoreConfig(['ethereum', 'arbitrum']),
      'ETH/ethereum-optimism': buildWarpCoreConfig(['ethereum', 'optimism']),
      'USDC/arbitrum-optimism': buildWarpCoreConfig(['arbitrum', 'optimism']),
    };

    it('should filter to routes containing all specified chains', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, [
        'ethereum',
        'arbitrum',
      ]);
      expect(Object.keys(result)).to.deep.equal(['ETH/ethereum-arbitrum']);
    });

    it('should return multiple routes when chains match multiple', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, ['ethereum']);
      expect(Object.keys(result).sort()).to.deep.equal([
        'ETH/ethereum-arbitrum',
        'ETH/ethereum-optimism',
      ]);
    });

    it('should return empty object when no routes match', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, ['polygon']);
      expect(Object.keys(result)).to.have.lengthOf(0);
    });

    it('should return all routes for empty chains array', () => {
      const result = filterWarpCoreConfigMapByChains(configMap, []);
      expect(Object.keys(result)).to.have.lengthOf(3);
    });
  });
});
