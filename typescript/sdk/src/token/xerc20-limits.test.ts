import { expect } from 'chai';
import { constants } from 'ethers';
import sinon from 'sinon';

import { assert } from '@hyperlane-xyz/utils';

import { test1 } from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { blockAt, stubAevoChainThatMoves } from '../test/aevoChainStubs.js';
import {
  aevoRaw,
  aevoUnauthorized,
  aevoUnlimited,
} from '../test/aevoTokenFixture.js';

import { AevoMintAuthority } from './adapters/ITokenAdapter.js';
import { XERC20Type } from './types.js';
import {
  AevoXERC20Limits,
  StandardXERC20Limits,
  VeloXERC20Limits,
  XERC20Limits,
  aevoCapToUint256,
  limitsAreZero,
  limitsMatch,
  readXERC20Limits,
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

  it('keeps the smallest raw cap', () => {
    const limits = aevoRaw('1');
    assert(limits.authorized, 'Expected an authorized minter');
    expect(aevoCapToUint256(limits.cap)).to.equal(1n);
  });

  // The token binds a minter to a cap of zero as no cap at all, so a raw value
  // that is not a positive uint256 must not reach it, also for a caller that
  // does not parse its config with the schema.
  const rejectedRawCaps = [
    { name: 'zero', value: '0' },
    { name: 'zero spelled with leading zeros', value: '000' },
    { name: 'a negative value', value: '-1' },
    {
      name: 'a value above the largest uint256',
      value: constants.MaxUint256.add(1).toString(),
    },
  ];

  for (const c of rejectedRawCaps) {
    it(`rejects a raw cap of ${c.name}`, () => {
      const limits = aevoRaw(c.value);
      assert(limits.authorized, 'Expected an authorized minter');
      expect(() => aevoCapToUint256(limits.cap)).to.throw(
        `A raw Aevo cap must be a positive uint256, got ${c.value}`,
      );
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

describe('readXERC20Limits for an Aevo token', () => {
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const MINTER = '0x4444444444444444444444444444444444444444';
  const HEAD = 100;

  let sandbox: sinon.SinonSandbox;
  let multiProtocolProvider: MultiProtocolProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProtocolProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider();
    sandbox
      .stub(multiProtocolProvider.getEthersV5Provider(test1.name), 'getBlock')
      .resolves(blockAt(HEAD));
  });

  afterEach(() => sandbox.restore());

  interface Case {
    name: string;
    atHead: AevoMintAuthority;
    afterHead: AevoMintAuthority;
    unpinnedHeights: number[];
    // What the limits of the minter are at the head.
    expected: AevoXERC20Limits;
    // What an unpinned read would report, which the token never held.
    torn: AevoXERC20Limits;
  }

  // A concurrent apply sets the cap and then authorizes the minter. A read that
  // pairs the cap before the first with the authority after the second reports
  // a minter without a bound, which a deploy config of an unlimited minter would
  // take for what it declares, and skip the update it needs.
  const cases: Case[] = [
    {
      name: 'a minter authorized after its cap is set',
      atHead: { authorized: false, cap: 0n },
      afterHead: { authorized: true, cap: 5_000_000n },
      unpinnedHeights: [HEAD + 1, HEAD],
      expected: aevoUnauthorized(),
      torn: aevoUnlimited(),
    },
    {
      name: 'a minter revoked along with its cap changed',
      atHead: { authorized: true, cap: 5_000_000n },
      afterHead: { authorized: false, cap: 7_000_000n },
      unpinnedHeights: [HEAD, HEAD + 1],
      expected: aevoRaw('5000000'),
      torn: aevoRaw('7000000'),
    },
  ];

  for (const c of cases) {
    it(`reports the authority and the cap of one block, for ${c.name}`, async () => {
      const chain = stubAevoChainThatMoves({
        sandbox,
        provider: multiProtocolProvider.getEthersV5Provider(test1.name),
        stateAt: { [HEAD]: c.atHead, [HEAD + 1]: c.afterHead },
        unpinnedHeights: c.unpinnedHeights,
      });

      const limits = await readXERC20Limits({
        multiProtocolProvider,
        chain: test1.name,
        xERC20Address: TOKEN,
        bridges: [MINTER],
        type: XERC20Type.Aevo,
      });

      expect(limits).to.deep.equal({ [MINTER]: c.expected });
      expect(limits[MINTER]).to.not.deep.equal(c.torn);
      expect(chain.calls.map((call) => call.height)).to.deep.equal([
        HEAD,
        HEAD,
      ]);
    });
  }
});
