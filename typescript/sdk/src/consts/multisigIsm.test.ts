import { expect } from 'chai';

import { isAddress, isZeroishAddress } from '@hyperlane-xyz/utils';

import { defaultMultisigConfigs } from './multisigIsm.js';

describe('MultisigIsm', () => {
  describe('defaultMultisigConfigs', () => {
    it('has thresholds that require a set majority', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        const minimumThreshold = Math.floor(config.validators.length / 2) + 1;
        expect(config.threshold).to.be.greaterThanOrEqual(
          minimumThreshold,
          `Threshold for ${chain} is too low, expected at least ${minimumThreshold}, got ${config.threshold}`,
        );
      }
    });

    it('has a valid number of validators for each threshold', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        expect(config.validators.length).to.be.greaterThanOrEqual(
          config.threshold,
          `Number of validators for ${chain} is less than the threshold, expected at least ${config.threshold}, got ${config.validators.length}`,
        );
      }
    });

    it('has valid EVM addresses for each validator', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        for (const validator of config.validators) {
          expect(isAddress(validator.address)).to.equal(
            true,
            `Validator address ${validator.address} for ${chain} is not a valid EVM address`,
          );
        }
      }
    });

    it('has no zeroish addresses for validators', async () => {
      for (const [chain, config] of Object.entries(defaultMultisigConfigs)) {
        for (const validator of config.validators) {
          expect(isZeroishAddress(validator.address)).to.equal(
            false,
            `Validator address ${validator.address} for ${chain} is a zeroish address`,
          );
        }
      }
    });

    it('has valid aliases for each validator', async () => {
      for (const config of Object.values(defaultMultisigConfigs)) {
        for (const validator of config.validators) {
          expect(validator.alias).to.not.be.empty;
        }
      }
    });
  });
});
