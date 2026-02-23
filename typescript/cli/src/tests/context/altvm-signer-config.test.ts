import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  resolveAltVmAccountAddress,
  resolveStarknetAccountAddress,
} from '../../context/altvm-signer-config.js';
import type { ExtendedChainSubmissionStrategy } from '../../submitters/types.js';

describe('altvm signer config helpers', () => {
  afterEach(() => {
    delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
  });

  it('reads Starknet address from strategy submitter', () => {
    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          privateKey: '0xabc',
          userAddress: '0x111',
        },
      },
    };

    expect(resolveStarknetAccountAddress(strategy, 'starknetsepolia')).to.equal(
      '0x111',
    );
  });

  it('falls back to userAddress and env var', () => {
    const strategy: Partial<ExtendedChainSubmissionStrategy> = {
      starknetsepolia: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: 'starknetsepolia',
          privateKey: '0xabc',
          userAddress: '0x222',
        },
      },
    };
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
