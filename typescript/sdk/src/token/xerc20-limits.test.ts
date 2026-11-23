import { expect } from 'chai';
import { constants } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import {
  aevoRaw,
  aevoUnauthorized,
  aevoUnlimited,
} from '../test/aevoTokenFixture.js';

import { XERC20Type } from './types.js';
import {
  AevoXERC20Limits,
  StandardXERC20Limits,
  VeloXERC20Limits,
  XERC20Limits,
  aevoCapToUint256,
  limitsAreZero,
  limitsMatch,
  toAevoLimits,
} from './xerc20-limits.js';

const standard = (mint: string, burn: string): StandardXERC20Limits => ({
  type: XERC20Type.Standard,
  mint,
  burn,
});
const velo = (
  bufferCap: string,
  rateLimitPerSecond: string,
): VeloXERC20Limits => ({
  type: XERC20Type.Velo,
  bufferCap,
  rateLimitPerSecond,
});

describe('limitsAreZero', () => {
  interface Case {
    name: string;
    limits: XERC20Limits;
    expected: boolean;
  }

  const cases: Case[] = [
    {
      name: 'Standard limits of zero',
      limits: standard('0', '0'),
      expected: true,
    },
    {
      name: 'a Standard mint limit',
      limits: standard('1', '0'),
      expected: false,
    },
    {
      name: 'a Standard burn limit',
      limits: standard('0', '1'),
      expected: false,
    },
    {
      name: 'Velodrome limits of zero',
      limits: velo('0', '0'),
      expected: true,
    },
    { name: 'a Velodrome buffer cap', limits: velo('1', '0'), expected: false },
    { name: 'a Velodrome rate limit', limits: velo('0', '1'), expected: false },
    {
      name: 'an Aevo minter that is not authorized',
      limits: aevoUnauthorized(),
      expected: true,
    },
    {
      name: 'an Aevo minter that is authorized with a raw cap',
      limits: aevoRaw('1000'),
      expected: false,
    },
    {
      // A minter the token does not bound is not a minter that may mint
      // nothing.
      name: 'an Aevo minter that is authorized and not bound',
      limits: aevoUnlimited(),
      expected: false,
    },
  ];

  for (const c of cases) {
    it(`is ${c.expected} for ${c.name}`, () => {
      expect(limitsAreZero(c.limits)).to.equal(c.expected);
    });
  }
});

describe('limitsMatch', () => {
  interface Case {
    name: string;
    a: XERC20Limits;
    b: XERC20Limits;
    expected: boolean;
  }

  const cases: Case[] = [
    {
      name: 'equal Standard limits',
      a: standard('1', '2'),
      b: standard('1', '2'),
      expected: true,
    },
    {
      name: 'Standard limits with another mint',
      a: standard('1', '2'),
      b: standard('3', '2'),
      expected: false,
    },
    {
      name: 'Standard limits with another burn',
      a: standard('1', '2'),
      b: standard('1', '3'),
      expected: false,
    },
    {
      name: 'equal Velodrome limits',
      a: velo('1', '2'),
      b: velo('1', '2'),
      expected: true,
    },
    {
      name: 'Velodrome limits with another buffer cap',
      a: velo('1', '2'),
      b: velo('3', '2'),
      expected: false,
    },
    {
      name: 'Velodrome limits with another rate limit',
      a: velo('1', '2'),
      b: velo('1', '3'),
      expected: false,
    },
    {
      name: 'equal Aevo limits with a cap',
      a: aevoRaw('1000'),
      b: aevoRaw('1000'),
      expected: true,
    },
    {
      name: 'equal Aevo limits that are not bound',
      a: aevoUnlimited(),
      b: aevoUnlimited(),
      expected: true,
    },
    {
      // A minter that is not authorized has no cap to compare.
      name: 'Aevo minters that are not authorized',
      a: aevoUnauthorized(),
      b: aevoUnauthorized(),
      expected: true,
    },
    {
      name: 'Aevo limits with another cap',
      a: aevoRaw('1000'),
      b: aevoRaw('2000'),
      expected: false,
    },
    {
      // The token stores a cap of zero for a minter it does not bound, which
      // reads as a bound of zero when mistaken for a number.
      name: 'an Aevo cap against a minter that is not bound',
      a: aevoRaw('1000'),
      b: aevoUnlimited(),
      expected: false,
    },
    {
      name: 'an Aevo minter that is not bound against one with a cap',
      a: aevoUnlimited(),
      b: aevoRaw('1000'),
      expected: false,
    },
    {
      name: 'an authorized Aevo minter against one that is not',
      a: aevoRaw('1000'),
      b: aevoUnauthorized(),
      expected: false,
    },
    {
      name: 'an unauthorized Aevo minter against one that is authorized',
      a: aevoUnauthorized(),
      b: aevoRaw('1000'),
      expected: false,
    },
    {
      name: 'an unauthorized Aevo minter against one that is authorized without a bound',
      a: aevoUnauthorized(),
      b: aevoUnlimited(),
      expected: false,
    },
    {
      name: 'Standard against Velodrome limits',
      a: standard('1', '2'),
      b: velo('1', '2'),
      expected: false,
    },
    {
      name: 'Velodrome against Standard limits',
      a: velo('1', '2'),
      b: standard('1', '2'),
      expected: false,
    },
    {
      name: 'Standard against Aevo limits',
      a: standard('1', '2'),
      b: aevoRaw('1'),
      expected: false,
    },
    {
      name: 'Aevo against Standard limits',
      a: aevoRaw('1'),
      b: standard('1', '2'),
      expected: false,
    },
    {
      name: 'Velodrome against Aevo limits',
      a: velo('1', '2'),
      b: aevoRaw('1'),
      expected: false,
    },
    {
      name: 'Aevo against Velodrome limits',
      a: aevoRaw('1'),
      b: velo('1', '2'),
      expected: false,
    },
  ];

  for (const c of cases) {
    it(`is ${c.expected} for ${c.name}`, () => {
      expect(limitsMatch(c.a, c.b)).to.equal(c.expected);
    });
  }
});

describe('toAevoLimits', () => {
  interface Case {
    name: string;
    onChain: { authorized: boolean; cap: bigint };
    expected: AevoXERC20Limits;
  }

  const cases: Case[] = [
    {
      name: 'a cap as the raw number the token keeps',
      onChain: { authorized: true, cap: 1_000_000n },
      expected: aevoRaw('1000000'),
    },
    {
      name: 'a cap of one',
      onChain: { authorized: true, cap: 1n },
      expected: aevoRaw('1'),
    },
    {
      name: 'a cap beyond 2^64',
      onChain: { authorized: true, cap: 2n ** 100n },
      expected: aevoRaw((2n ** 100n).toString()),
    },
    {
      name: 'the largest cap a uint256 holds',
      onChain: { authorized: true, cap: constants.MaxUint256.toBigInt() },
      expected: aevoRaw(constants.MaxUint256.toString()),
    },
    {
      // The token mints without bound for an authorized minter whose cap is
      // zero, so it is not a minter with a cap of zero.
      name: 'a cap of zero as no bound',
      onChain: { authorized: true, cap: 0n },
      expected: aevoUnlimited(),
    },
    {
      name: 'a minter that is not authorized without the cap the token kept',
      onChain: { authorized: false, cap: 1_000_000n },
      expected: aevoUnauthorized(),
    },
    {
      name: 'a minter that is not authorized and has no cap',
      onChain: { authorized: false, cap: 0n },
      expected: aevoUnauthorized(),
    },
  ];

  for (const c of cases) {
    it(`maps ${c.name}`, () => {
      expect(toAevoLimits(c.onChain)).to.deep.equal(c.expected);
    });
  }
});

describe('aevoCapToUint256', () => {
  interface Case {
    name: string;
    limits: AevoXERC20Limits;
    expected: bigint;
  }

  // Authorized minters only: a minter that is not authorized declares no cap.
  const cases: Case[] = [
    // The token keeps a cap of zero for a minter it does not bound.
    { name: 'an unlimited cap', limits: aevoUnlimited(), expected: 0n },
    { name: 'a raw cap', limits: aevoRaw('5000000'), expected: 5_000_000n },
    {
      name: 'the largest cap a uint256 holds',
      limits: aevoRaw(constants.MaxUint256.toString()),
      expected: constants.MaxUint256.toBigInt(),
    },
  ];

  for (const c of cases) {
    it(`keeps ${c.name} as ${c.expected}`, () => {
      assert(c.limits.authorized, 'Expected an authorized minter');
      expect(aevoCapToUint256(c.limits.cap)).to.equal(c.expected);
    });
  }

  const onChainCaps = [
    0n,
    1n,
    5_000_000n,
    2n ** 100n,
    constants.MaxUint256.toBigInt(),
  ];

  for (const cap of onChainCaps) {
    it(`returns the cap ${cap} the token keeps as it is read`, () => {
      const limits = toAevoLimits({ authorized: true, cap });
      assert(limits.authorized, 'Expected an authorized minter');
      expect(aevoCapToUint256(limits.cap)).to.equal(cap);
    });
  }
});
