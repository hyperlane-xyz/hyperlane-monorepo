import { expect } from 'chai';

import { difference, setEquality, symmetricDifference } from './sets.js';

describe('Set Operations', () => {
  describe('difference', () => {
    it('should return the difference of two sets', () => {
      const setA = new Set([1, 2, 3, undefined]);
      const setB = new Set([2, 3, 4]);
      const result = difference(setA, setB);
      expect(result).to.deep.equal(new Set([1, undefined]));
    });
  });

  describe('symmetricDifference', () => {
    it('should return the symmetric difference of two sets', () => {
      const setA = new Set([1, 2, 3]);
      const setB = new Set([2, 3, 4]);
      const result = symmetricDifference(setA, setB);
      expect(result).to.deep.equal(new Set([1, 4]));
    });
  });

  describe('setEquality', () => {
    it('should return true for equal sets', () => {
      const setA = new Set([1, 2, 3]);
      const setB = new Set([1, 2, 3]);
      const result = setEquality(setA, setB);
      expect(result).to.be.true;
    });

    it('should return false for non-equal sets', () => {
      const setA = new Set([1, 2, 3]);
      const setB = new Set([1, 2, 4]);
      const result = setEquality(setA, setB);
      expect(result).to.be.false;
    });
  });
});
