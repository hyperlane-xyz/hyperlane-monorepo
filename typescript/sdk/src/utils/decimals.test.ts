import { assert, expect } from 'chai';

import { randomAddress } from '../test/testUtils.js';
import { TokenType } from '../token/config.js';
import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';

import {
  alignLocalAmountToMessage,
  localAmountFromMessage,
  messageAmountFromLocal,
  minLocalAmountForMessage,
  normalizeScale,
  scalesEqual,
  verifyScale,
} from './decimals.js';

describe(normalizeScale.name, () => {
  it('should normalize undefined to DEFAULT_SCALE', () => {
    const result = normalizeScale(undefined);
    expect(result).to.deep.equal({ numerator: 1n, denominator: 1n });
  });

  it('should normalize a plain number to {BigInt(n), 1n}', () => {
    const result = normalizeScale(1000);
    expect(result).to.deep.equal({ numerator: 1000n, denominator: 1n });
  });

  it('should normalize {number, number} to {bigint, bigint}', () => {
    const result = normalizeScale({ numerator: 5, denominator: 3 });
    expect(result).to.deep.equal({ numerator: 5n, denominator: 3n });
  });

  it('should pass through {bigint, bigint} unchanged', () => {
    const result = normalizeScale({ numerator: 10n ** 18n, denominator: 1n });
    expect(result).to.deep.equal({ numerator: 10n ** 18n, denominator: 1n });
  });
});

describe(scalesEqual.name, () => {
  it('should treat undefined as equal to {1n, 1n}', () => {
    expect(scalesEqual(undefined, { numerator: 1n, denominator: 1n })).to.be
      .true;
    expect(scalesEqual(undefined, undefined)).to.be.true;
  });

  it('should accept plain number scales (backwards compat)', () => {
    expect(scalesEqual(1000, 1000)).to.be.true;
    expect(scalesEqual(1000, 2000)).to.be.false;
    expect(scalesEqual(1, undefined)).to.be.true;
  });

  it('should accept {number, number} scales (backwards compat)', () => {
    expect(scalesEqual({ numerator: 1000, denominator: 1 }, 1000)).to.be.true;
    expect(
      scalesEqual(
        { numerator: 1, denominator: 2 },
        { numerator: 2, denominator: 4 },
      ),
    ).to.be.true;
  });

  it('should compare mixed scale types correctly', () => {
    // number vs bigint object
    expect(scalesEqual(1000, { numerator: 1000n, denominator: 1n })).to.be.true;
    // number object vs bigint object
    expect(
      scalesEqual(
        { numerator: 1000, denominator: 1 },
        { numerator: 1000n, denominator: 1n },
      ),
    ).to.be.true;
  });

  it('should compare bigint scales', () => {
    expect(
      scalesEqual(
        { numerator: 1_000_000_000_000n, denominator: 1n },
        { numerator: 1_000_000_000_000n, denominator: 1n },
      ),
    ).to.be.true;
    expect(
      scalesEqual(
        { numerator: 1n, denominator: 1n },
        { numerator: 2n, denominator: 1n },
      ),
    ).to.be.false;
  });

  it('should compare fractional scales via cross-multiplication', () => {
    expect(
      scalesEqual(
        { numerator: 1n, denominator: 2n },
        { numerator: 2n, denominator: 4n },
      ),
    ).to.be.true;
    expect(
      scalesEqual(
        { numerator: 1n, denominator: 3n },
        { numerator: 1n, denominator: 2n },
      ),
    ).to.be.false;
  });

  it('should handle large values without precision loss', () => {
    // 10^18 exceeds Number.MAX_SAFE_INTEGER
    const large = { numerator: 10n ** 18n, denominator: 1n };
    const slightlyDifferent = { numerator: 10n ** 18n + 1n, denominator: 1n };
    expect(scalesEqual(large, large)).to.be.true;
    expect(scalesEqual(large, slightlyDifferent)).to.be.false;
  });
});

describe('scale conversion helpers', () => {
  it('converts local amount to message amount using floor rounding', () => {
    expect(
      messageAmountFromLocal(5n, { numerator: 1n, denominator: 3n }),
    ).to.equal(1n);
    expect(
      messageAmountFromLocal(2n, { numerator: 3n, denominator: 2n }),
    ).to.equal(3n);
  });

  it('converts message amount to local amount using inbound floor rounding', () => {
    expect(
      localAmountFromMessage(7n, { numerator: 3n, denominator: 2n }),
    ).to.equal(4n);
    expect(
      localAmountFromMessage(1n, { numerator: 1n, denominator: 3n }),
    ).to.equal(3n);
  });

  it('computes the minimum local amount needed to reach a message amount', () => {
    expect(
      minLocalAmountForMessage(7n, { numerator: 3n, denominator: 2n }),
    ).to.equal(5n);
    expect(
      minLocalAmountForMessage(2n, { numerator: 1n, denominator: 3n }),
    ).to.equal(6n);
  });

  it('rejects negative message amounts for ceil local conversion', () => {
    expect(() =>
      minLocalAmountForMessage(-1n, { numerator: 1n, denominator: 3n }),
    ).to.throw('Numerator must be non-negative');
  });

  it('aligns local amounts to exact message progress without leaking local dust', () => {
    expect(
      alignLocalAmountToMessage(5n, { numerator: 1n, denominator: 3n }),
    ).to.deep.equal({
      localAmount: 3n,
      messageAmount: 1n,
    });
    expect(
      alignLocalAmountToMessage(5n, { numerator: 3n, denominator: 2n }),
    ).to.deep.equal({
      localAmount: 5n,
      messageAmount: 7n,
    });
    expect(
      alignLocalAmountToMessage(999_999_999_999n, {
        numerator: 1n,
        denominator: 1_000_000_000_000n,
      }),
    ).to.deep.equal({
      localAmount: 0n,
      messageAmount: 0n,
    });
  });

  it('rejects negative local amounts for alignment', () => {
    expect(() =>
      alignLocalAmountToMessage(-1n, { numerator: 1n, denominator: 3n }),
    ).to.throw('Local amount must be non-negative');
  });
});

describe(verifyScale.name, () => {
  const TOKEN_NAME = 'TOKEN';
  const ETH_DECIMALS = 18;
  const USDC_DECIMALS = 6;

  it('should return true when all decimals are uniform', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      [
        'chain2',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return true when all decimals are uniform and scale is not provided', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
      [
        'chain2',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return false when decimals are uniform but scales are mismatched', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: 1000,
        },
      ],
      [
        'chain2',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.false;
  });

  it('should return true with plain number scale (backwards compat)', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: USDC_DECIMALS,
          scale: 1_000_000_000_000,
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return true with bigint scale', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: USDC_DECIMALS,
          scale: { numerator: 1_000_000_000_000n, denominator: 1n },
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return false when decimals are non-uniform and an incorrect scale is provided', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: USDC_DECIMALS,
          scale: 100,
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.false;
  });

  it('should return false when decimals are non-uniform and scale is missing', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      [
        'chain2',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.false;
  });

  it('should throw an error if decimals are not defined for a token config', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      ['chain2', { name: TOKEN_NAME, symbol: TOKEN_NAME }],
    ]);

    assert.throws(
      () => verifyScale(configMap),
      'Decimals must be defined for token config on chain chain2',
    );
  });

  it('should handle WarpRouteDeployConfigMailboxRequired input type', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: ETH_DECIMALS,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: USDC_DECIMALS,
        scale: 1_000_000_000_000,
        mailbox: randomAddress(),
      },
    };

    expect(verifyScale(config)).to.be.true;
  });

  it('should handle WarpRouteDeployConfigMailboxRequired with uniform decimals', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: ETH_DECIMALS,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: ETH_DECIMALS,
        mailbox: randomAddress(),
      },
    };

    expect(verifyScale(config)).to.be.true;
  });

  it('should return false for WarpRouteDeployConfigMailboxRequired with incorrect scale', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: ETH_DECIMALS,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: USDC_DECIMALS,
        scale: 1000,
        mailbox: randomAddress(),
      },
    };

    expect(verifyScale(config)).to.be.false;
  });

  it('should throw an error for WarpRouteDeployConfigMailboxRequired with missing decimals', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: ETH_DECIMALS,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: undefined,
        mailbox: randomAddress(),
      },
    };

    assert.throws(
      () => verifyScale(config),
      'Decimals must be defined for token config on chain chain2',
    );
  });

  // --- Scale-down (BSC-style) tests ---
  // Convention: max-decimal chain carries {numerator:1, denominator:N}, others carry no scale.
  // This keeps message encoding at the lower decimal precision.

  it('should return true with scale-down on the high-decimal chain', () => {
    // BSC (18 dec) scales down by 1/1e12, ETH (6 dec) carries no scale.
    // Effective message amount: BSC = 1/1e12 * 10^18 = 10^6, ETH = 1 * 10^6 = 10^6 ✓
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'bsc',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 1, denominator: 1_000_000_000_000 },
        },
      ],
      [
        'eth',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return false when scale-down ratio is incorrect', () => {
    // BSC uses wrong denominator (100 instead of 1e12)
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'bsc',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 1, denominator: 100 },
        },
      ],
      [
        'eth',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.false;
  });

  it('should return true with mixed scale-up and scale-down reaching the same effective amount', () => {
    // chain1 (18 dec) scales down by 1/1e6, chain2 (6 dec) scales up by 1e6.
    // Both reach 10^12 effective message encoding.
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 1, denominator: 1_000_000 },
        },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: USDC_DECIMALS,
          scale: 1_000_000,
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return true with scale-down across three chains', () => {
    // BSC (18), ETH (6), and a third 6-decimal chain — all consistent with BSC scale-down
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'bsc',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 1, denominator: 1_000_000_000_000 },
        },
      ],
      [
        'eth',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
      [
        'arbitrum',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: USDC_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return true with scale-down using WarpRouteDeployConfigMailboxRequired', () => {
    // BSC (18dec) scales down by 1/1e12 to match ETH (6dec) — via deploy config input type
    const config: WarpRouteDeployConfigMailboxRequired = {
      bsc: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: ETH_DECIMALS,
        scale: { numerator: 1, denominator: 1_000_000_000_000 },
        mailbox: randomAddress(),
      },
      eth: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: USDC_DECIMALS,
        mailbox: randomAddress(),
      },
    };

    expect(verifyScale(config)).to.be.true;
  });

  it('should return true when two chains both use scale-down to the same effective amount', () => {
    // chain1 (18dec) with 1/1e12 → effective 10^6
    // chain2 (12dec) with 1/1e6 → effective 10^6
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 1, denominator: 1_000_000_000_000 },
        },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: 12,
          scale: { numerator: 1, denominator: 1_000_000 },
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return true for non-reduced equivalent fractions (uniform decimals)', () => {
    // Both 18dec: one with 2/2e12 (non-reduced), one with 1/1e12 (reduced) — equivalent
    // Cross-multiply check: 2 * 1e12 === 1 * 2e12 → 2e12 === 2e12 ✓
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 2, denominator: 2_000_000_000_000 },
        },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: ETH_DECIMALS,
          scale: { numerator: 1, denominator: 1_000_000_000_000 },
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return true for a single-chain config', () => {
    // Single chain — no pairs to compare, trivially consistent
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });

  it('should return false when three chains have the third inconsistent', () => {
    // chain1 (18dec, no scale), chain2 (6dec, scale 1e12 ✓), chain3 (6dec, scale 100 ✗)
    const configMap: Map<string, TokenMetadata> = new Map([
      [
        'chain1',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: ETH_DECIMALS },
      ],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: USDC_DECIMALS,
          scale: 1_000_000_000_000,
        },
      ],
      [
        'chain3',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: USDC_DECIMALS,
          scale: 100,
        },
      ],
    ]);

    expect(verifyScale(configMap)).to.be.false;
  });

  it('should return true for an empty config', () => {
    const configMap: Map<string, TokenMetadata> = new Map();
    expect(verifyScale(configMap)).to.be.true;
  });

  it('should treat decimals: 0 as defined (not falsy)', () => {
    // Exercises the nullish check fix (config.decimals != null).
    // decimals: 0 is falsy but defined — should not throw.
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 0 }],
    ]);

    expect(verifyScale(configMap)).to.be.true;
  });
});
