import { expect } from 'chai';

import { safelyAccessEnvVar } from './env.js';

describe('Env Utilities', () => {
  describe('safelyAccessEnvVar', () => {
    it('should return the environment variable', () => {
      process.env.TEST_VAR = '0xTEST_VAR';
      expect(safelyAccessEnvVar('TEST_VAR')).to.equal('0xTEST_VAR');
      expect(safelyAccessEnvVar('TEST_VAR', true)).to.equal('0xtest_var');
    });

    it('should return undefined if the environment variable is not set', () => {
      expect(safelyAccessEnvVar('NON_EXISTENT_VAR')).to.be.undefined;
      expect(safelyAccessEnvVar('NON_EXISTENT_VAR', true)).to.be.undefined;
    });
  });
});
