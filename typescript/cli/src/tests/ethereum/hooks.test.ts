import { expect } from 'chai';

import { HookType, HooksConfigMap } from '@hyperlane-xyz/sdk';

import { readHooksConfigMap } from '../../config/hooks.js';

describe('readHooksConfigMap', () => {
  it('parses and validates example correctly', () => {
    const hooks = readHooksConfigMap('examples/hooks.yaml');

    const exampleHooksConfig: HooksConfigMap = {
      anvil1: {
        required: {
          type: HookType.PROTOCOL_FEE,
          owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          beneficiary: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '200000000000000',
        },
        default: {
          type: HookType.ROUTING,
          owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          domains: {
            anvil2: {
              type: HookType.AGGREGATION,
              hooks: [
                {
                  type: HookType.MERKLE_TREE,
                },
                {
                  type: HookType.INTERCHAIN_GAS_PAYMASTER,
                  beneficiary: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                  oracleKey: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                  overhead: { anvil2: 50000 },
                  oracleConfig: {
                    anvil2: {
                      gasPrice: '100',
                      tokenExchangeRate: '100',
                    },
                  },
                },
              ],
            },
          },
        },
      },
      anvil2: {
        required: {
          type: HookType.PROTOCOL_FEE,
          owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          beneficiary: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          maxProtocolFee: '1000000000000000000',
          protocolFee: '200000000000000',
        },
        default: {
          type: HookType.ROUTING,
          owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          domains: {
            anvil1: {
              type: HookType.AGGREGATION,
              hooks: [
                {
                  type: HookType.MERKLE_TREE,
                },
                {
                  type: HookType.INTERCHAIN_GAS_PAYMASTER,
                  beneficiary: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                  oracleKey: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                  overhead: { anvil1: 50000 },
                  oracleConfig: {
                    anvil1: {
                      gasPrice: '100',
                      tokenExchangeRate: '100',
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    expect(hooks).to.deep.equal(exampleHooksConfig);
  });

  it('parsing failure, missing internal key "overhead"', () => {
    expect(() => {
      readHooksConfigMap('src/tests/hooks/safe-parse-fail.yaml');
    }).to.throw();
  });
});
