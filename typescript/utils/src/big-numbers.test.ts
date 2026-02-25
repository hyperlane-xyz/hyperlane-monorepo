import { expect } from 'chai';

import { isNumberish, isZeroish } from './big-numbers.js';

describe('isNumberish', () => {
  const testCases = [
    { expect: false, context: 'invalid number', case: 'invalidNumber' },
    { expect: false, context: 'NaN', case: NaN },
    { expect: false, context: 'undefined', case: undefined },
    { expect: false, context: 'null', case: null },
    { expect: true, context: 'decimal', case: 123.123 },
    { expect: true, context: 'integer', case: 300_000 },
    { expect: true, context: 'hex 0', case: 0x00 },
    { expect: true, context: 'hex 0', case: 0x000 },
    {
      expect: true,
      context: 'address 0',
      case: 0x0000000000000000000000000000000000000000,
    },
  ];
  testCases.forEach((tc) => {
    it(`returns ${tc.expect} for ${tc.case}`, () => {
      expect(isNumberish(tc.case!)).to.equal(tc.expect);
    });
  });
});

describe('isZeroish', () => {
  const testCases = [
    { expect: false, context: 'invalid number', case: 'invalidNumber' },
    { expect: false, context: 'NaN', case: NaN },
    { expect: false, context: 'undefined', case: undefined },
    { expect: false, context: 'null', case: null },
    { expect: false, context: 'non 0 decimal', case: 123.123 },
    { expect: false, context: 'non 0 integer', case: 123 },
    { expect: true, context: 'hex 0', case: 0x00 },
    { expect: true, context: 'hex 0', case: 0x000 },
    {
      expect: true,
      context: 'address 0',
      case: 0x0000000000000000000000000000000000000000,
    },
  ];
  testCases.forEach((tc) => {
    it(`returns ${tc.expect} for ${tc.case}`, () => {
      expect(isZeroish(tc.case!)).to.equal(tc.expect);
    });
  });
});
