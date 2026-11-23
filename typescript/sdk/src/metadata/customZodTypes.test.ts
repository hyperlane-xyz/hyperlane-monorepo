import { expect } from 'chai';

import { ZUint32 } from './customZodTypes.js';

describe('ZUint32', () => {
  for (const value of [0, 0n, '0', 4294967295, 4294967295n, '4294967295']) {
    it(`accepts the ${typeof value} boundary ${value}`, () => {
      expect(ZUint32.parse(value)).to.equal(Number(value));
    });
  }

  for (const value of [
    -1,
    -1n,
    '-1',
    4294967296,
    4294967296n,
    '4294967296',
    1.5,
    '1.5',
    NaN,
    Infinity,
    '0x1',
    null,
    {},
  ]) {
    it(`rejects ${typeof value} ${String(value)}`, () => {
      expect(ZUint32.safeParse(value).success).to.equal(false);
    });
  }

  it('normalizes a mixed array without changing domain order', () => {
    expect(ZUint32.array().parse([4294967295n, '0', 1])).to.deep.equal([
      4294967295, 0, 1,
    ]);
  });
});
