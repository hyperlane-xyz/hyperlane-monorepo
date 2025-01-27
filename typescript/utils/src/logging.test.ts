import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { ethersBigNumberSerializer } from './logging.js';

describe('Logging Utilities', () => {
  describe('ethersBigNumberSerializer', () => {
    it('should serialize a BigNumber object correctly', () => {
      const key = 'testKey';
      const value = {
        type: 'BigNumber',
        hex: '0x1a',
      };
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(BigNumber.from(value.hex).toString());
    });

    it('should return the value unchanged if it is not a BigNumber', () => {
      const key = 'testKey';
      const value = { some: 'object' };
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });

    it('should return the value unchanged if it is null', () => {
      const key = 'testKey';
      const value = null;
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });

    it('should return the value unchanged if it is not an object', () => {
      const key = 'testKey';
      const value = 'string';
      const result = ethersBigNumberSerializer(key, value);
      expect(result).to.equal(value);
    });
  });
});
