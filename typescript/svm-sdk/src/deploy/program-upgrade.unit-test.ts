import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  MAX_ACCOUNT_DATA_SIZE,
  MIN_PROGRAM_DATA_EXTEND_BYTES,
} from '../constants.js';

import {
  extendFitsAccountLimit,
  requiredExtendBytes,
} from './program-upgrade.js';

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
  ];

  for (const { name, newProgramLen, currentMaxProgramLen, expected } of cases) {
    it(name, () => {
      expect(requiredExtendBytes(newProgramLen, currentMaxProgramLen)).to.equal(
        expected,
      );
    });
  }
});

describe('extendFitsAccountLimit', () => {
  const cases: Array<{
    name: string;
    currentAccountSize: number;
    additionalBytes: number;
    expected: boolean;
  }> = [
    {
      name: 'fits when well under the account limit',
      currentAccountSize: 1_000_000,
      additionalBytes: MIN_PROGRAM_DATA_EXTEND_BYTES,
      expected: true,
    },
    {
      name: 'fits exactly at the account limit',
      currentAccountSize: MAX_ACCOUNT_DATA_SIZE - MIN_PROGRAM_DATA_EXTEND_BYTES,
      additionalBytes: MIN_PROGRAM_DATA_EXTEND_BYTES,
      expected: true,
    },
    {
      name: 'does not fit one byte past the account limit',
      currentAccountSize:
        MAX_ACCOUNT_DATA_SIZE - MIN_PROGRAM_DATA_EXTEND_BYTES + 1,
      additionalBytes: MIN_PROGRAM_DATA_EXTEND_BYTES,
      expected: false,
    },
    {
      name: 'does not fit when a near-full account is clamped up to the minimum extend',
      currentAccountSize: MAX_ACCOUNT_DATA_SIZE - 1,
      additionalBytes: MIN_PROGRAM_DATA_EXTEND_BYTES,
      expected: false,
    },
  ];

  for (const { name, currentAccountSize, additionalBytes, expected } of cases) {
    it(name, () => {
      expect(
        extendFitsAccountLimit(currentAccountSize, additionalBytes),
      ).to.equal(expected);
    });
  }
});
