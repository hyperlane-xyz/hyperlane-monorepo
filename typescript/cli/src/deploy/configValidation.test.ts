import { expect } from 'chai';

import { HookType, TokenType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  validateCoreConfigForAltVM,
  validateWarpConfigForAltVM,
} from './configValidation.js';

describe('AltVM config validation', () => {
  it('allows protocol fee hooks for Starknet core configs', () => {
    const config = {
      owner: '0x1',
      defaultIsm: '0x2',
      defaultHook: { type: HookType.MERKLE_TREE },
      requiredHook: {
        type: HookType.PROTOCOL_FEE,
        owner: '0x1',
        beneficiary: '0x3',
        maxProtocolFee: '10',
        protocolFee: '1',
      },
    };

    expect(() =>
      validateCoreConfigForAltVM(
        config as any,
        'starknet-test',
        ProtocolType.Starknet,
      ),
    ).to.not.throw();
  });

  it('rejects IGP hooks for Starknet core configs', () => {
    const config = {
      owner: '0x1',
      defaultIsm: '0x2',
      defaultHook: {
        type: HookType.INTERCHAIN_GAS_PAYMASTER,
        owner: '0x1',
        beneficiary: '0x2',
        oracleKey: 'oracle',
        overhead: {},
        oracleConfig: {},
      },
      requiredHook: { type: HookType.MERKLE_TREE },
    };

    expect(() =>
      validateCoreConfigForAltVM(
        config as any,
        'starknet-test',
        ProtocolType.Starknet,
      ),
    ).to.throw("Unsupported hook type 'interchainGasPaymaster'");
  });

  it('rejects protocol fee hooks for non-Starknet warp configs', () => {
    const config = {
      type: TokenType.native,
      owner: '0x1',
      mailbox: '0x2',
      hook: {
        type: HookType.PROTOCOL_FEE,
        owner: '0x1',
        beneficiary: '0x2',
        maxProtocolFee: '10',
        protocolFee: '1',
      },
      remoteRouters: {},
      destinationGas: {},
    };

    expect(() =>
      validateWarpConfigForAltVM(
        config as any,
        'cosmosnative-test',
        ProtocolType.CosmosNative,
      ),
    ).to.throw("Unsupported hook type 'protocolFee'");
  });
});
