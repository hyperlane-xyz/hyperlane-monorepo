import { expect } from 'chai';
import { ethers } from 'ethers';

import { GasRouterConfigSchema } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;

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
});
