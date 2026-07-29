import { type Address, address as parseAddress } from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { FEATURE_GATE_PROGRAM_ADDRESS } from './constants.js';
import { isActiveFeatureAccount } from './feature-gate.js';

const OTHER_OWNER = parseAddress('11111111111111111111111111111111');

const activeData = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
const pendingData = Buffer.from([0]).toString('base64');

describe('isActiveFeatureAccount', () => {
  const cases: Array<{
    name: string;
    account: { owner: Address; data: readonly [string, string] } | null;
    expected: boolean;
  }> = [
    {
      name: 'returns false when the account is missing',
      account: null,
      expected: false,
    },
    {
      name: 'returns false when not owned by the feature program',
      account: { owner: OTHER_OWNER, data: [activeData, 'base64'] },
      expected: false,
    },
    {
      name: 'returns false when activated_at is None (pending)',
      account: {
        owner: FEATURE_GATE_PROGRAM_ADDRESS,
        data: [pendingData, 'base64'],
      },
      expected: false,
    },
    {
      name: 'returns true when activated_at is Some (active)',
      account: {
        owner: FEATURE_GATE_PROGRAM_ADDRESS,
        data: [activeData, 'base64'],
      },
      expected: true,
    },
  ];

  for (const { name, account, expected } of cases) {
    it(name, () => {
      expect(isActiveFeatureAccount(account)).to.equal(expected);
    });
  }
});
