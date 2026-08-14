import { expect } from 'chai';
import { ethers } from 'ethers';

import { GasRouterConfigSchema } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const EXECUTOR_ADDRESS = ethers.Wallet.createRandom().address;
const PROPOSER_ADDRESS = ethers.Wallet.createRandom().address;
const VALID_TIMELOCK = {
  delay: 259200,
  roles: {
    executor: EXECUTOR_ADDRESS,
    proposer: PROPOSER_ADDRESS,
  },
};

describe('GasRouterConfigSchema', () => {
  const baseConfig = {
    owner: SOME_ADDRESS,
    mailbox: SOME_ADDRESS,
  };

  it('should accept config without feeHook', () => {
    const result = GasRouterConfigSchema.safeParse(baseConfig);
    expect(result.success).to.be.true;
  });

  it('should accept config with feeHook', () => {
    const result = GasRouterConfigSchema.safeParse({
      ...baseConfig,
      feeHook: SOME_ADDRESS,
    });
    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.feeHook).to.equal(SOME_ADDRESS);
    }
  });

  it('should reject feeHook with invalid address', () => {
    const result = GasRouterConfigSchema.safeParse({
      ...baseConfig,
      feeHook: 'not-an-address',
    });
    expect(result.success).to.be.false;
  });

  it('should accept config with timelock', () => {
    const result = GasRouterConfigSchema.safeParse({
      ...baseConfig,
      timelock: VALID_TIMELOCK,
    });

    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.timelock?.delay).to.equal(259200);
      expect(result.data.timelock?.roles.executor).to.equal(EXECUTOR_ADDRESS);
      expect(result.data.timelock?.roles.proposer).to.equal(PROPOSER_ADDRESS);
    }
  });

  for (const [name, timelock] of [
    [
      'non-EVM executor hash',
      {
        ...VALID_TIMELOCK,
        roles: {
          ...VALID_TIMELOCK.roles,
          executor:
            '0x1111111111111111111111111111111111111111111111111111111111111111',
        },
      },
    ],
    [
      'invalid executor checksum',
      {
        ...VALID_TIMELOCK,
        roles: {
          ...VALID_TIMELOCK.roles,
          executor: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72',
        },
      },
    ],
    ['unsafe delay', { ...VALID_TIMELOCK, delay: Number.MAX_SAFE_INTEGER + 1 }],
    [
      'zero-address proposer',
      {
        ...VALID_TIMELOCK,
        roles: {
          ...VALID_TIMELOCK.roles,
          proposer: ethers.constants.AddressZero,
        },
      },
    ],
    ['zero delay', { ...VALID_TIMELOCK, delay: 0 }],
  ]) {
    it(`should reject timelock with ${name}`, () => {
      const result = GasRouterConfigSchema.safeParse({
        ...baseConfig,
        timelock,
      });

      expect(result.success).to.be.false;
    });
  }

  it('should accept timelock with zero-address executor', () => {
    const result = GasRouterConfigSchema.safeParse({
      ...baseConfig,
      timelock: {
        ...VALID_TIMELOCK,
        roles: {
          ...VALID_TIMELOCK.roles,
          executor: ethers.constants.AddressZero,
        },
      },
    });

    expect(result.success).to.be.true;
  });
});
