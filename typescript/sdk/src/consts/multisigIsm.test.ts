import { expect } from 'chai';

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
  });
});
