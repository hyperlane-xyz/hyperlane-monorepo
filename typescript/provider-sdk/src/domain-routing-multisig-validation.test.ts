import { expect } from 'chai';

import {
  DomainMultisigConfig,
  assertValidDomainRoutingMultisig,
} from './ism.js';

const V1 = '0x1111111111111111111111111111111111111111';
const V2 = '0x2222222222222222222222222222222222222222';
const V3 = '0x3333333333333333333333333333333333333333';
const LABEL = 'domain 7';

describe('assertValidDomainRoutingMultisig', () => {
  interface Case {
    name: string;
    config: DomainMultisigConfig;
    error?: RegExp;
  }
  const cases: Case[] = [
    {
      name: 'accepts threshold 1',
      config: { validators: [V1, V2, V3], threshold: 1 },
    },
    {
      name: 'accepts threshold equal to the validator count',
      config: { validators: [V1, V2, V3], threshold: 3 },
    },
    {
      name: 'rejects threshold 0',
      config: { validators: [V1], threshold: 0 },
      error:
        /^domain 7 has threshold 0, expected an integer between 1 and the validator count \(1\)$/,
    },
    {
      name: 'rejects threshold above the validator count',
      config: { validators: [V1, V2, V3], threshold: 4 },
      error:
        /^domain 7 has threshold 4, expected an integer between 1 and the validator count \(3\)$/,
    },
    {
      name: 'rejects a non-integer threshold',
      config: { validators: [V1, V2], threshold: 1.5 },
      error: /^domain 7 has threshold 1\.5/,
    },
    {
      name: 'rejects a negative threshold',
      config: { validators: [V1, V2], threshold: -1 },
      error: /^domain 7 has threshold -1/,
    },
    {
      name: 'rejects an empty validator set from untyped input',
      config: { validators: JSON.parse('[]'), threshold: 1 },
      error: /^domain 7 must have at least one validator$/,
    },
    {
      name: 'rejects duplicate validators',
      config: { validators: [V1, V2, V1], threshold: 1 },
      error: /^domain 7 has a duplicate validator address: /,
    },
    {
      name: 'rejects duplicate validators differing by case',
      config: {
        validators: [V1, '0x' + 'A'.repeat(40), '0x' + 'a'.repeat(40)],
        threshold: 1,
      },
      error: /^domain 7 has a duplicate validator address: 0xa+$/,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const run = () => {
        assertValidDomainRoutingMultisig(c.config, LABEL);
      };
      if (c.error) expect(run).to.throw(c.error);
      else expect(run).to.not.throw();
    });
  }
});
