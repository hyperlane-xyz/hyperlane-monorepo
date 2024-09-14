import { expect } from 'chai';

import { deepCopy, deepEquals, objMerge, objSlice } from './objects.js';

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
    expect(merged).to.eql({ a: 2, b: { c: ['arr1', 'arr2'] } });
  });

  it('objSlice', () => {
    const obj1 = { a: 1, b: { c: ['arr1'], d: 'string' } };
    const obj2 = { a: true, b: { c: true } };
    const sliced = objSlice(obj1, obj2);
    expect(sliced).to.eql({ b: { d: 'string' } });
  });

  it('objSlice with array', () => {
    const obj1 = { a: 1, b: { c: ['arr1', 'arr2'], d: 'string' } };
    const obj2 = { b: { c: ['arr1'] } };
    const sliced1_2 = objSlice(obj1, obj2, 10, true);
    expect(sliced1_2).to.eql({ a: 1, b: { c: ['arr2'], d: 'string' } });

    const obj3 = { a: [{ b: 1 }], c: 2 };
    const obj4 = { a: [{ b: 1 }] };
    const sliced3_4 = objSlice(obj3, obj4, 10, true);
    expect(sliced3_4).to.eql({ a: [], c: 2 });
  });
});
