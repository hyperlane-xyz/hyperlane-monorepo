import { expect } from 'chai';

import { environments } from '../config/environments/index.js';

describe('Environment', () => {
  for (const env of Object.values(environments)) {
    it(`Has owners configured for ${env.environment}`, () => {
      for (const chain of env.supportedChainNames) {
        expect(
          env.owners[chain],
          `Missing owner for chain ${chain} in environment ${env.environment}`,
        ).to.not.be.undefined;
      }
    });
  }
});
