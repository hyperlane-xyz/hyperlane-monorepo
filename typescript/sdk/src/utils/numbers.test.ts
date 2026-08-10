import { expect } from 'chai';

import { toNumber } from './numbers.js';

interface ParsedCase {
  name: string;
  value: unknown;
  expected: number;
}

const parsedCases: ParsedCase[] = [
  {
    // How Etherscan and Blockscout report a zero valued hex field, which
    // parseInt reads as NaN.
    name: 'a hex string carrying no digits',
    value: '0x',
    expected: 0,
  },
  { name: 'a zero hex string', value: '0x0', expected: 0 },
  { name: 'a hex string', value: '0xff', expected: 255 },
  { name: 'an upper case hex string', value: '0xFF', expected: 255 },
  { name: 'a decimal string', value: '5755676', expected: 5_755_676 },
  { name: 'a JSON number', value: 5_755_676, expected: 5_755_676 },
  { name: 'a bigint', value: 5_755_676n, expected: 5_755_676 },
  {
    name: 'the largest bigint a number represents exactly',
    value: 2n ** 53n - 1n,
    expected: 9_007_199_254_740_991,
  },
];

interface RejectedCase {
  name: string;
  value: unknown;
  expectedError: string;
}

const rejectedCases: RejectedCase[] = [
  {
    name: 'a block tag',
    value: 'pending',
    expectedError:
      'blockNumber string "pending" is not a valid hex or decimal number',
  },
  {
    name: 'an empty string',
    value: '',
    expectedError: 'blockNumber string "" is not a valid hex or decimal number',
  },
  {
    name: 'a hex string with a non hex digit',
    value: '0xfg',
    expectedError:
      'blockNumber string "0xfg" is not a valid hex or decimal number',
  },
  {
    name: 'a hex string above the safe integer range',
    value: '0x20000000000000',
    expectedError:
      'blockNumber string value "0x20000000000000" exceeds safe integer range',
  },
  {
    name: 'a bigint above the safe integer range',
    value: 9_007_199_254_740_993n,
    expectedError:
      'blockNumber bigint value 9007199254740993 exceeds safe integer range',
  },
  {
    // The boundary itself: Number(2n ** 53n) is finite and reads back as the
    // same bigint, which is what a round trip check accepted, but the doubles
    // above it step by two so it is not a safe integer.
    name: 'a bigint at the safe integer boundary',
    value: 2n ** 53n,
    expectedError:
      'blockNumber bigint value 9007199254740992 exceeds safe integer range',
  },
  {
    name: 'a fractional number',
    value: 1.5,
    expectedError: 'blockNumber is not a safe integer: 1.5',
  },
  {
    name: 'a missing value',
    value: undefined,
    expectedError: 'Unable to convert blockNumber to number',
  },
];

describe('toNumber', () => {
  for (const c of parsedCases) {
    it(`parses ${c.name}`, () => {
      expect(toNumber(c.value, 'blockNumber')).to.equal(c.expected);
    });
  }

  for (const c of rejectedCases) {
    it(`rejects ${c.name}`, () => {
      expect(() => toNumber(c.value, 'blockNumber')).to.throw(c.expectedError);
    });
  }
});
