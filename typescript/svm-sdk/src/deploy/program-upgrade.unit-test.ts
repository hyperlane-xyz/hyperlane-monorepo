import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  MAX_ACCOUNT_DATA_SIZE,
  MIN_PROGRAM_DATA_EXTEND_BYTES,
} from '../constants.js';

import { PROGRAM_DATA_HEADER_SIZE } from './program-deployer.js';
import {
  newBinaryFitsAccountLimit,
  requiredExtendBytes,
} from './program-upgrade.js';

// Largest program a program-data account can hold: the account cap minus the
// fixed metadata header.
const MAX_PROGRAM_LEN = MAX_ACCOUNT_DATA_SIZE - PROGRAM_DATA_HEADER_SIZE;

describe('requiredExtendBytes', () => {
  const cases: Array<{
    name: string;
    newProgramLen: number;
    currentMaxProgramLen: number;
    expected: number;
  }> = [
    {
      name: 'returns 0 when the new binary is smaller',
      newProgramLen: 90_000,
      currentMaxProgramLen: 100_000,
      expected: 0,
    },
    {
      name: 'returns 0 when the new binary fits exactly',
      newProgramLen: 100_000,
      currentMaxProgramLen: 100_000,
      expected: 0,
    },
    {
      name: 'clamps a sub-minimum deficit up to the loader minimum',
      newProgramLen: 106_672,
      currentMaxProgramLen: 100_000,
      expected: MIN_PROGRAM_DATA_EXTEND_BYTES,
    },
    {
      name: 'passes a deficit larger than the minimum through unchanged',
      newProgramLen: 115_000,
      currentMaxProgramLen: 100_000,
      expected: 15_000,
    },
    {
      name: 'returns the minimum at the exact boundary',
      newProgramLen: 100_000 + MIN_PROGRAM_DATA_EXTEND_BYTES,
      currentMaxProgramLen: 100_000,
      expected: MIN_PROGRAM_DATA_EXTEND_BYTES,
    },
    {
      // Near the cap, clamping a sub-minimum deficit up to the loader minimum
      // would overflow the account; request the remaining headroom instead.
      name: 'requests the remaining headroom rather than overflowing the cap',
      newProgramLen: MAX_PROGRAM_LEN - 3_000,
      currentMaxProgramLen: MAX_PROGRAM_LEN - 5_000,
      expected: 5_000,
    },
    {
      name: 'requests exactly the headroom when the binary fills the account to the cap',
      newProgramLen: MAX_PROGRAM_LEN,
      currentMaxProgramLen: MAX_PROGRAM_LEN - 3_000,
      expected: 3_000,
    },
  ];

  for (const { name, newProgramLen, currentMaxProgramLen, expected } of cases) {
    it(name, () => {
      expect(requiredExtendBytes(newProgramLen, currentMaxProgramLen)).to.equal(
        expected,
      );
    });
  }
});

describe('newBinaryFitsAccountLimit', () => {
  const cases: Array<{
    name: string;
    newProgramLen: number;
    expected: boolean;
  }> = [
    {
      name: 'fits when well under the maximum program size',
      newProgramLen: 1_000_000,
      expected: true,
    },
    {
      name: 'fits a binary exactly at the maximum program size',
      newProgramLen: MAX_PROGRAM_LEN,
      expected: true,
    },
    {
      name: 'does not fit a binary one byte over the maximum program size',
      newProgramLen: MAX_PROGRAM_LEN + 1,
      expected: false,
    },
  ];

  for (const { name, newProgramLen, expected } of cases) {
    it(name, () => {
      expect(newBinaryFitsAccountLimit(newProgramLen)).to.equal(expected);
    });
  }
});
