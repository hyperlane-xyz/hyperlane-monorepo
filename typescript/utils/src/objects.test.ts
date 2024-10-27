import { expect } from 'chai';

import {
  deepCopy,
  deepEquals,
  diffObjMerge,
  isObject,
  objMerge,
  objOmit,
} from './objects.js';

describe('Object utilities', () => {
  it('deepEquals', () => {
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2 })).to.be.true;
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 })).to.be.false;
    expect(deepEquals({ a: 1, b: 2 }, { a: 1, b: 4 })).to.be.false;
  });

  it('deepCopy', () => {
    expect(deepCopy({ a: 1, b: 2 })).to.eql({ a: 1, b: 2 });
    expect(deepCopy({ a: 1, b: 2 })).to.not.eql({ a: 1, b: 3 });
  });

  it('objMerge', () => {
    const obj1 = { a: 1, b: 2, c: { d: '4' } };
    const obj2 = { b: 3, c: { d: '5' } };
    const merged = objMerge(obj1, obj2);
    expect(merged).to.eql({ a: 1, b: 3, c: { d: '5' } });
  });

  it('objMerge with array', () => {
    const obj1 = { a: 1, b: { c: ['arr1'] } };
    const obj2 = { a: 2, b: { c: ['arr2'] } };
    const merged = objMerge(obj1, obj2, 10, true);
    expect(merged).to.eql({ a: 2, b: { c: ['arr2', 'arr1'] } });
  });

  it('objMerge without array', () => {
    const obj1 = { a: 1, b: { c: ['arr1'] } };
    const obj2 = { a: 2, b: { c: ['arr2'] } };
    const merged = objMerge(obj1, obj2, 10, false);
    expect(merged).to.eql({ a: 2, b: { c: ['arr2'] } });
  });

  it('objMerge overwrites nested values', () => {
    const obj1 = { a: { b: 10 }, c: 'value' };
    const obj2 = { a: { b: 20 } };
    const merged = objMerge(obj1, obj2);
    expect(merged).to.eql({ a: { b: 20 }, c: 'value' });
  });

  it('objOmit', () => {
    const obj1 = { a: 1, b: { c: ['arr1'], d: 'string' } };
    const obj2 = { a: true, b: { c: true } };
    const omitted = objOmit(obj1, obj2);
    expect(omitted).to.eql({ b: { d: 'string' } });
  });

  it('objOmit with array', () => {
    const obj1 = { a: 1, b: { c: ['arr1', 'arr2'], d: 'string' } };
    const obj2 = { b: { c: ['arr1'] } };
    const omitted1_2 = objOmit(obj1, obj2, 10, true);
    expect(omitted1_2).to.eql({ a: 1, b: { c: ['arr2'], d: 'string' } });

    const obj3 = { a: [{ b: 1 }], c: 2 };
    const obj4 = { a: [{ b: 1 }] };
    const omitted3_4 = objOmit(obj3, obj4, 10, true);
    expect(omitted3_4).to.eql({ a: [], c: 2 });
  });

  it('objOmit without array', () => {
    const obj1 = { a: 1, b: { c: ['arr1', 'arr2'], d: 'string' } };
    const obj2 = { b: { c: ['arr1'] } };
    const omitted1_2 = objOmit(obj1, obj2, 10, false);
    expect(omitted1_2).to.eql({ a: 1, b: { d: 'string' } });
  });

  it('isObject', () => {
    expect(isObject({})).to.be.true;
    expect(isObject([])).to.be.false;
    expect(isObject(null)).to.be.false;
    expect(isObject(undefined)).to.be.false;
    expect(isObject(42)).to.be.false;
  });

  describe('diffObjMerge', () => {
    it('should merge objects with equal values', () => {
      const actual = { a: 1, b: 2 };
      const expected = { a: 1, b: 2 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: false,
        mergedObject: { a: 1, b: 2 },
      });
    });

    it('should return a diff for objects with different values', () => {
      const actual = { a: 1, b: 2 };
      const expected = { a: 1, b: 3 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: { actual: 2, expected: 3 },
        },
      });
    });

    it('should detect missing fields in the top level object', () => {
      const actual = { a: 1 };
      const expected = { a: 1, b: 3 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: { actual: '', expected: 3 },
        },
      });
    });

    it('should detect extra fields in the top level object', () => {
      const actual = { a: 1, b: 2 };
      const expected = { a: 1 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: { actual: 2, expected: '' },
        },
      });
    });

    it('should merge nested objects and show differences', () => {
      const actual = { a: 1, b: { c: 2, d: 4 } };
      const expected = { a: 1, b: { c: 2, d: 3 } };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          a: 1,
          b: {
            c: 2,
            d: { actual: 4, expected: 3 },
          },
        },
      });
    });

    it('should throw an error when maxDepth is exceeded', () => {
      const actual = { a: { b: { c: { d: { e: 5 } } } } };
      const expected = { a: { b: { c: { d: { e: 5 } } } } };

      expect(() => diffObjMerge(actual, expected, 3)).to.Throw(
        'diffObjMerge tried to go too deep',
      );
    });

    it('should merge arrays of equal length and show the diffs', () => {
      const actual = [1, 2, 3];
      const expected = [1, 2, 4];

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: [1, 2, { actual: 3, expected: 4 }],
      });
    });

    it('should return a diff for arrays of different lengths', () => {
      const actual = [1, 2];
      const expected = [1, 2, 3];

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: true,
        mergedObject: {
          actual,
          expected,
        },
      });
    });

    it('should handle null and undefined values properly', () => {
      const actual = { a: null, b: 2 };
      const expected = { a: undefined, b: 2 };

      const result = diffObjMerge(actual, expected);

      expect(result).to.eql({
        isInvalid: false,
        mergedObject: {
          a: undefined,
          b: 2,
        },
      });
    });
  });
});
