import { expect } from 'chai';

import {
  ChainConfigSchema,
  KeyConfigSchema,
  KeyFunderConfigSchema,
  SweepConfigSchema,
} from './types.js';

describe('KeyFunderConfig Schemas', () => {
  describe('KeyConfigSchema', () => {
    it('should validate a valid key config', () => {
      const config = {
        address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
        role: 'hyperlane-relayer',
        desiredBalance: '0.5',
      };
      const result = KeyConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject invalid address', () => {
      const config = {
        address: 'invalid-address',
        desiredBalance: '0.5',
      };
      const result = KeyConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject invalid balance', () => {
      const config = {
        address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
        desiredBalance: 'not-a-number',
      };
      const result = KeyConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should reject negative balance', () => {
      const config = {
        address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
        desiredBalance: '-1',
      };
      const result = KeyConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should allow optional role', () => {
      const config = {
        address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
        desiredBalance: '0.5',
      };
      const result = KeyConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
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

    it('should reject trigger multiplier less than target + 0.05', () => {
      const config = {
        enabled: true,
        address: '0x478be6076f31E9666123B9721D0B6631baD944AF',
        threshold: '0.5',
        targetMultiplier: 1.5,
        triggerMultiplier: 1.52, // Less than 1.5 + 0.05
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should use default multipliers', () => {
      const config = {
        enabled: true,
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
        triggerMultiplier: 1.5, // Would fail if enabled
      };
      const result = SweepConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });

  describe('ChainConfigSchema', () => {
    it('should validate chain config with keys only', () => {
      const config = {
        keys: [
          {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
            desiredBalance: '0.5',
          },
        ],
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should validate chain config with igp', () => {
      const config = {
        igp: {
          address: '0x6cA0B6D43F8e45C82e57eC5a5F2Bce4bF2b6F1f7',
          claimThreshold: '0.2',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should validate complete chain config', () => {
      const config = {
        keys: [
          {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
            role: 'relayer',
            desiredBalance: '0.5',
          },
        ],
        igp: {
          address: '0x6cA0B6D43F8e45C82e57eC5a5F2Bce4bF2b6F1f7',
          claimThreshold: '0.2',
        },
        sweep: {
          enabled: true,
          threshold: '0.3',
        },
      };
      const result = ChainConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });
  });

  describe('KeyFunderConfigSchema', () => {
    it('should validate minimal config', () => {
      const config = {
        version: '1',
        chains: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
    });

    it('should reject invalid version', () => {
      const config = {
        version: '2',
        chains: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.false;
    });

    it('should validate complete config', () => {
      const config = {
        version: '1',
        chains: {
          ethereum: {
            keys: [
              {
                address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
                role: 'hyperlane-relayer',
                desiredBalance: '0.5',
              },
            ],
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
        },
        funder: {
          privateKeyEnvVar: 'FUNDER_PRIVATE_KEY',
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

    it('should apply default funder privateKeyEnvVar', () => {
      const config = {
        version: '1',
        chains: {},
        funder: {},
      };
      const result = KeyFunderConfigSchema.safeParse(config);
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.funder?.privateKeyEnvVar).to.equal(
          'FUNDER_PRIVATE_KEY',
        );
      }
    });
  });
});
