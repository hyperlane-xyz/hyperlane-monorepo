import { expect } from 'chai';

import { mean, median, randomInt, stdDev, sum } from './math.js';

describe('Math Utility Functions', () => {
  describe('median', () => {
    it('should return the median of an odd-length array', () => {
      expect(median([1, 3, 2])).to.equal(2);
    });

    it('should return the median of an even-length array', () => {
      expect(median([1, 2, 3, 4])).to.equal(2.5);
    });

    it('should return the median of an even-length array with non sorted numbers', () => {
      expect(median([1, 2, 0, 4, 5, 6])).to.equal(3);
    });
  });

  describe('sum', () => {
    it('should return the sum of an array', () => {
      expect(sum([1, 2, 3, 4])).to.equal(10);
      expect(sum([1, -2, 3, 4])).to.equal(6);
    });
  });

  describe('mean', () => {
    it('should return the mean of an array', () => {
      expect(mean([1, 2, 3, 4])).to.equal(2.5);
    });
  });

  describe('stdDev', () => {
    it('should return the standard deviation of an array', () => {
      expect(stdDev([1, 2, 3, 4])).to.be.closeTo(1.118, 0.001);
    });

    it('should return the standard deviation of an array with negative numbers', () => {
      expect(stdDev([-1, -2, -3, -4])).to.be.closeTo(1.118, 0.001);
    });
  });

  describe('randomInt', () => {
    it('should return a random integer within the specified range', () => {
      const min = 1;
      const max = 10;
      const result = randomInt(max, min);
      expect(result).to.be.at.least(min);
      expect(result).to.be.below(max);
      expect(result % 1).to.equal(0); // its an integer
    });
  });
});
