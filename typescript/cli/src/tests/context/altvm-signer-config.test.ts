import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  resolveAltVmAccountAddress,
  resolveStarknetAccountAddress,
} from '../../context/altvm-signer-config.js';

describe('altvm signer config helpers', () => {
  afterEach(() => {
    delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
  });

  it('reads Starknet accountAddress from strategy submitter', () => {
    const strategy = {
      starknetsepolia: {
        submitter: {
          type: 'jsonRpc',
          privateKey: '0xabc',
          accountAddress: '0x111',
        },
      },
    } as any;

    expect(resolveStarknetAccountAddress(strategy, 'starknetsepolia')).to.equal(
      '0x111',
    );
  });

  it('falls back to userAddress and env var', () => {
    const strategy = {
      starknetsepolia: {
        submitter: {
          type: 'jsonRpc',
          privateKey: '0xabc',
          userAddress: '0x222',
        },
      },
    } as any;
    expect(resolveStarknetAccountAddress(strategy, 'starknetsepolia')).to.equal(
      '0x222',
    );

    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = '0x333';
    expect(resolveStarknetAccountAddress({}, 'starknetsepolia')).to.equal(
      '0x333',
    );
  });

  it('returns undefined for non-Starknet protocol', () => {
    expect(
      resolveAltVmAccountAddress({}, ProtocolType.CosmosNative, 'osmosis'),
    ).to.equal(undefined);
  });
});
