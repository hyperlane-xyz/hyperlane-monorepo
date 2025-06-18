import { Address } from '@arbitrum/sdk';
import { expect } from 'chai';

import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';

import { transformConfigToCheck } from './configUtils.js';

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
});
