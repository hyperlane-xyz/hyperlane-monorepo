import { expect } from 'chai';
import { ethers } from 'ethers';

import { GasRouterConfigSchema } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;
const EXECUTOR_ADDRESS = ethers.Wallet.createRandom().address;
const PROPOSER_ADDRESS = ethers.Wallet.createRandom().address;

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
      timelock: {
        delay: 259200,
        roles: {
          executor: EXECUTOR_ADDRESS,
          proposer: PROPOSER_ADDRESS,
        },
      },
    });

    expect(result.success).to.be.true;
    if (result.success) {
      expect(result.data.timelock?.delay).to.equal(259200);
      expect(result.data.timelock?.roles.executor).to.equal(EXECUTOR_ADDRESS);
      expect(result.data.timelock?.roles.proposer).to.equal(PROPOSER_ADDRESS);
    }
  });

  it('should reject timelock roles with non-EVM hashes', () => {
    const result = GasRouterConfigSchema.safeParse({
      ...baseConfig,
      timelock: {
        delay: 259200,
        roles: {
          executor:
            '0x1111111111111111111111111111111111111111111111111111111111111111',
          proposer: PROPOSER_ADDRESS,
        },
      },
    });

    expect(result.success).to.be.false;
  });

  it('should reject timelock with invalid delay', () => {
    const result = GasRouterConfigSchema.safeParse({
      ...baseConfig,
      timelock: {
        delay: 0,
        roles: {
          executor: SOME_ADDRESS,
          proposer: SOME_ADDRESS,
        },
      },
    });

    expect(result.success).to.be.false;
  });
});
