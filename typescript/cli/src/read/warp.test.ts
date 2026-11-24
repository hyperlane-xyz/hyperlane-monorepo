import { expect } from 'chai';

import {
  type AevoXERC20Limits,
  XERC20AevoCapType,
  XERC20Type,
} from '@hyperlane-xyz/sdk';

import { formatAevoLimits } from './warp.js';

describe('formatAevoLimits', () => {
  interface Case {
    name: string;
    limits: AevoXERC20Limits;
    decimals: number;
    expected: { authorized: string; cap: string };
  }

  const cases: Case[] = [
    {
      name: 'a router that is not authorized has no cap to report',
      limits: { type: XERC20Type.Aevo, authorized: false },
      decimals: 6,
      expected: { authorized: 'no', cap: '-' },
    },
    {
      name: 'a router without a cap is reported as unlimited',
      limits: {
        type: XERC20Type.Aevo,
        authorized: true,
        cap: { type: XERC20AevoCapType.Unlimited },
      },
      decimals: 6,
      expected: { authorized: 'yes', cap: 'unlimited' },
    },
    {
      name: 'a cap is reported in the units of the token',
      limits: {
        type: XERC20Type.Aevo,
        authorized: true,
        cap: { type: XERC20AevoCapType.Raw, value: '5000000' },
      },
      decimals: 6,
      expected: { authorized: 'yes', cap: '5.0' },
    },
    {
      name: 'a cap above 2^53 keeps every digit',
      limits: {
        type: XERC20Type.Aevo,
        authorized: true,
        cap: { type: XERC20AevoCapType.Raw, value: '123456789012345678901' },
      },
      decimals: 6,
      expected: {
        authorized: 'yes',
        cap: '123456789012345.678901',
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(formatAevoLimits(c.limits, c.decimals)).to.deep.equal(c.expected);
    });
  }
});
