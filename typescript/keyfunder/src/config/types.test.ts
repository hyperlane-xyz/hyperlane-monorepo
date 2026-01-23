import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { calculateMultipliedBalance } from '../core/KeyFunder.js';

import {
  ChainConfigSchema,
  KeyFunderConfigSchema,
  RoleConfigSchema,
  SweepConfigSchema,
} from './types.js';

describe('KeyFunderConfig Schemas', () => {
  describe('RoleConfigSchema', () => {
    it('should validate a valid role config', () => {
      const config = {
        address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
      };
      const result = RoleConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject invalid address', () => {
      const config = {
        address: 'invalid-address',
      };
      const result = RoleConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject missing address', () => {
      const config = {};
      const result = RoleConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });
  });

  describe('SweepConfigSchema', () => {
    it('should validate valid sweep config', () => {
      const config = {
        enabled: true,
        address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
        threshold: '0.5',
        targetMultiplier: 1.5,
        triggerMultiplier: 2.0,
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject enabled sweep config without address', () => {
      const config = {
        enabled: true,
        threshold: '0.5',
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject enabled sweep config without threshold', () => {
      const config = {
        enabled: true,
        address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject trigger multiplier less than target + 0.05', () => {
      const config = {
        enabled: true,
        address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
        threshold: '0.5',
        targetMultiplier: 1.5,
        triggerMultiplier: 1.52,
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should use default multipliers', () => {
      const config = {
        enabled: true,
        address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
        threshold: '0.5',
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.targetMultiplier).to.equal(1.5);
        expect(result.data.triggerMultiplier).to.equal(2.0);
      }
    });

    it('should skip validation when disabled', () => {
      const config = {
        enabled: false,
        targetMultiplier: 1.5,
        triggerMultiplier: 1.5,
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });

  describe('ChainConfigSchema', () => {
    it('should validate chain config with balances only', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '0.5',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should validate chain config with igp including address', () => {
      const config = {
        igp: {
          address: '0x6cA0B6D43F8e45C82e57eC5a5F2Bce4bF2b6F1f7',
          claimThreshold: '0.2',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should validate chain config with igp without address (registry fallback)', () => {
      const config = {
        igp: {
          claimThreshold: '0.2',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should validate complete chain config', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '0.5',
          'hyperlane-kathy': '0.3',
        },
        igp: {
          address: '0x6cA0B6D43F8e45C82e57eC5a5F2Bce4bF2b6F1f7',
          claimThreshold: '0.2',
        },
        sweep: {
          enabled: true,
          address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
          threshold: '0.3',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject invalid balance value', () => {
      const config = {
        balances: {
          'hyperlane-relayer': 'not-a-number',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject scientific notation in balances', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '1e3',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject balances with too many decimals', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '1.1234567890123456789',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject negative balance', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '-1',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject balance without leading digit (.5)', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '.5',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should accept balance with leading zero (0.5)', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '0.5',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should accept high precision balances (up to 18 decimals)', () => {
      const config = {
        balances: {
          'hyperlane-relayer': '0.000000000000000001',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });

  describe('Multiplier precision (calculateMultipliedBalance)', () => {
    const oneEther = BigNumber.from('1000000000000000000');

    it('should calculate 1.5x correctly (1 ETH * 1.5 = 1.5 ETH)', () => {
      const result = calculateMultipliedBalance(oneEther, 1.5);
      expect(result.toString()).to.equal('1500000000000000000');
    });

    it('should calculate 2.0x correctly (1 ETH * 2.0 = 2 ETH)', () => {
      const result = calculateMultipliedBalance(oneEther, 2.0);
      expect(result.toString()).to.equal('2000000000000000000');
    });

    it('should floor third decimal (1 ETH * 1.555 = 1.55 ETH, not 1.56 ETH)', () => {
      const result = calculateMultipliedBalance(oneEther, 1.555);
      expect(result.toString()).to.equal('1550000000000000000');
    });

    it('should floor (1 ETH * 1.999 = 1.99 ETH, not 2 ETH)', () => {
      const result = calculateMultipliedBalance(oneEther, 1.999);
      expect(result.toString()).to.equal('1990000000000000000');
    });

    it('should handle 1.0x multiplier (identity)', () => {
      const result = calculateMultipliedBalance(oneEther, 1.0);
      expect(result.toString()).to.equal(oneEther.toString());
    });
  });

  describe('Funding amount calculation logic', () => {
    const MIN_DELTA_NUMERATOR = BigNumber.from(6);
    const MIN_DELTA_DENOMINATOR = BigNumber.from(10);

    function simulateFundingCalculation(
      currentBalance: BigNumber,
      desiredBalance: BigNumber,
    ): BigNumber {
      if (currentBalance.gte(desiredBalance)) {
        return BigNumber.from(0);
      }
      const delta = desiredBalance.sub(currentBalance);
      const minDelta = desiredBalance
        .mul(MIN_DELTA_NUMERATOR)
        .div(MIN_DELTA_DENOMINATOR);
      return delta.gt(minDelta) ? delta : BigNumber.from(0);
    }

    const oneEther = BigNumber.from('1000000000000000000');

    it('should return 0 when currentBalance equals desiredBalance (underflow guard)', () => {
      const result = simulateFundingCalculation(oneEther, oneEther);
      expect(result.toString()).to.equal('0');
    });

    it('should return 0 when currentBalance exceeds desiredBalance (underflow guard)', () => {
      const result = simulateFundingCalculation(oneEther.mul(2), oneEther);
      expect(result.toString()).to.equal('0');
    });

    it('should return 0 when deficit is below 60% threshold (0.5 ETH balance, 1 ETH desired)', () => {
      const currentBalance = oneEther.div(2);
      const result = simulateFundingCalculation(currentBalance, oneEther);
      expect(result.toString()).to.equal('0');
    });

    it('should return delta when deficit exceeds 60% threshold (0.3 ETH balance, 1 ETH desired)', () => {
      const currentBalance = oneEther.mul(3).div(10);
      const result = simulateFundingCalculation(currentBalance, oneEther);
      const expectedDelta = oneEther.sub(currentBalance);
      expect(result.toString()).to.equal(expectedDelta.toString());
    });

    it('should return full amount when balance is 0', () => {
      const result = simulateFundingCalculation(BigNumber.from(0), oneEther);
      expect(result.toString()).to.equal(oneEther.toString());
    });
  });

  describe('KeyFunderConfigSchema', () => {
    it('should validate minimal config', () => {
      const config = {
        version: '1',
        roles: {},
        chains: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject invalid version', () => {
      const config = {
        version: '2',
        roles: {},
        chains: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject missing roles', () => {
      const config = {
        version: '1',
        chains: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should validate complete config', () => {
      const config = {
        version: '1',
        roles: {
          'hyperlane-relayer': {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
          },
          'hyperlane-kathy': {
            address: '0x5fb02f40f56d15f0442a39d11a23f73747095b20',
          },
        },
        chains: {
          ethereum: {
            balances: {
              'hyperlane-relayer': '0.5',
              'hyperlane-kathy': '0.4',
            },
            igp: {
              address: '0x6cA0B6D43F8e45C82e57eC5a5F2Bce4bF2b6F1f7',
              claimThreshold: '0.2',
            },
            sweep: {
              enabled: true,
              address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
              threshold: '0.3',
            },
          },
          arbitrum: {
            balances: {
              'hyperlane-relayer': '0.1',
            },
          },
        },
        metrics: {
          pushGateway: 'http://prometheus:9091',
          jobName: 'keyfunder',
          labels: {
            environment: 'mainnet3',
          },
        },
        chainsToSkip: ['polygon'],
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject undefined role reference in chain balances', () => {
      const config = {
        version: '1',
        roles: {
          'hyperlane-relayer': {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
          },
        },
        chains: {
          ethereum: {
            balances: {
              'hyperlane-relayer': '0.5',
              'undefined-role': '0.3',
            },
          },
        },
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should use default chainTimeoutMs', () => {
      const config = {
        version: '1',
        roles: {},
        chains: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.chainTimeoutMs).to.equal(60_000);
      }
    });

    it('should accept custom chainTimeoutMs within bounds', () => {
      const config = {
        version: '1',
        roles: {},
        chains: {},
        chainTimeoutMs: 120_000,
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.chainTimeoutMs).to.equal(120_000);
      }
    });

    it('should reject chainTimeoutMs below minimum (10s)', () => {
      const config = {
        version: '1',
        roles: {},
        chains: {},
        chainTimeoutMs: 5_000,
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject chainTimeoutMs above maximum (300s)', () => {
      const config = {
        version: '1',
        roles: {},
        chains: {},
        chainTimeoutMs: 400_000,
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should allow chain balances that reference defined roles', () => {
      const config = {
        version: '1',
        roles: {
          'hyperlane-relayer': {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
          },
          'hyperlane-kathy': {
            address: '0x5fb02f40f56d15f0442a39d11a23f73747095b20',
          },
        },
        chains: {
          ethereum: {
            balances: {
              'hyperlane-relayer': '0.5',
            },
          },
          arbitrum: {
            balances: {
              'hyperlane-relayer': '0.1',
              'hyperlane-kathy': '0.05',
            },
          },
        },
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });
});
