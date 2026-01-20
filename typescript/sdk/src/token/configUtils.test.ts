import { Address } from '@arbitrum/sdk';
import { expect } from 'chai';
import { constants } from 'ethers';

import { ResolvedRoutingFeeConfigInput, TokenFeeType } from '../fee/types.js';
import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';

import { TokenType } from './config.js';
import {
  resolveTokenFeeAddress,
  transformConfigToCheck,
} from './configUtils.js';
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
                address: Address,
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
        bps: 100n,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      );

      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.owner).to.equal(OWNER_ADDRESS);
    });

    it('should resolve token to collateral address for collateral tokens', () => {
      const input = {
        type: TokenFeeType.LinearFee as const,
        owner: OWNER_ADDRESS,
        bps: 100n,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        collateralConfig,
      );

      expect(result.token).to.equal(COLLATERAL_TOKEN);
    });

    it('should resolve token to AddressZero for native tokens', () => {
      const input = {
        type: TokenFeeType.LinearFee as const,
        owner: OWNER_ADDRESS,
        bps: 100n,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        nativeConfig,
      );

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
            bps: 100n,
          },
          arbitrum: {
            type: TokenFeeType.LinearFee as const,
            owner: OWNER_ADDRESS,
            bps: 50n,
          },
        },
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      );

      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.type).to.equal(TokenFeeType.RoutingFee);

      const routingResult = result as ResolvedRoutingFeeConfigInput;
      expect(routingResult.feeContracts?.ethereum?.token).to.equal(
        ROUTER_ADDRESS,
      );
      expect(routingResult.feeContracts?.arbitrum?.token).to.equal(
        ROUTER_ADDRESS,
      );
    });

    it('should handle RoutingFee without feeContracts', () => {
      const input = {
        type: TokenFeeType.RoutingFee as const,
        owner: OWNER_ADDRESS,
      };

      const result = resolveTokenFeeAddress(
        input,
        ROUTER_ADDRESS,
        syntheticConfig,
      );

      expect(result.token).to.equal(ROUTER_ADDRESS);
      expect(result.type).to.equal(TokenFeeType.RoutingFee);
    });
  });
});
