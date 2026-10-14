import { expect } from 'chai';

import {
  type NonEmptyArray,
  chunk,
  exclude,
  isNonEmptyArray,
  nonEmptyArray,
  randomElement,
  sortArrayByKey,
} from './arrays.js';

describe('Arrays utilities', () => {
  describe('chunk', () => {
    it('should split an array into chunks of the specified size', () => {
      const result = chunk([1, 2, 3, 4, 5], 2);
      expect(result).to.deep.equal([[1, 2], [3, 4], [5]]);
    });

    it('should return an empty array when input is empty', () => {
      const result = chunk([], 2);
      expect(result).to.deep.equal([]);
    });

    it('should handle chunk size larger than array length', () => {
      const result = chunk([1, 2], 5);
      expect(result).to.deep.equal([[1, 2]]);
    });
  });

  describe('exclude', () => {
    it('should exclude the specified item from the list', () => {
      const result = exclude(2, [1, 2, 3, 2]);
      expect(result).to.deep.equal([1, 3]);
    });

    it('should return the same list if item is not found', () => {
      const result = exclude(4, [1, 2, 3]);
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('should return an empty list if all items are excluded', () => {
      const result = exclude(1, [1, 1, 1]);
      expect(result).to.deep.equal([]);
    });
  });

  describe('randomElement', () => {
    beforeEach(() => {});

    it('should return a random element from the list', () => {
      const list = [10, 20, 30];
      const result = randomElement(list);
      expect(result).to.be.oneOf(list);
    });

    it('should handle an empty list gracefully', () => {
      const result = randomElement([]);
      expect(result).to.be.undefined;
    });
  });

  describe('sortArrayByKey', () => {
    it('should sort objects by string key in ascending order', () => {
      const array = [
        { name: 'Charlie', id: 3 },
        { name: 'Alice', id: 1 },
        { name: 'Bob', id: 2 },
      ];
      const result = sortArrayByKey(array, 'name');
      expect(result).to.deep.equal([
        { name: 'Alice', id: 1 },
        { name: 'Bob', id: 2 },
        { name: 'Charlie', id: 3 },
      ]);
    });

    it('should sort objects by numeric key in ascending order', () => {
      const array = [
        { name: 'Charlie', value: 30 },
        { name: 'Alice', value: 10 },
        { name: 'Bob', value: 20 },
      ];
      const result = sortArrayByKey(array, 'value');
      expect(result).to.deep.equal([
        { name: 'Alice', value: 10 },
        { name: 'Bob', value: 20 },
        { name: 'Charlie', value: 30 },
      ]);
    });

    it('should return an empty array when input is empty', () => {
      const result = sortArrayByKey([], 'any');
      expect(result).to.deep.equal([]);
    });
  });

  describe('nonEmptyArray', () => {
    it('should return the elements as a non-empty tuple', () => {
      const result: NonEmptyArray<number> = nonEmptyArray([1, 2, 3]);
      const first: number = result[0];
      expect(first).to.equal(1);
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('should accept a single element', () => {
      expect(nonEmptyArray(['a'])).to.deep.equal(['a']);
    });

    it('should accept an undefined first element for a nullable T', () => {
      const input: (number | undefined)[] = [undefined, 1];
      expect(nonEmptyArray(input)).to.deep.equal([undefined, 1]);
    });

    it('should throw on an empty array', () => {
      expect(() => nonEmptyArray([])).to.throw('expected non-empty array');
    });
  });

  describe('isNonEmptyArray', () => {
    it('should be true for a non-empty array and false for an empty one', () => {
      expect(isNonEmptyArray([1])).to.equal(true);
      expect(isNonEmptyArray([undefined])).to.equal(true);
      expect(isNonEmptyArray([])).to.equal(false);
    });
  });
});
