import { assert, expect } from 'chai';

import { randomAddress } from '../test/testUtils.js';
import { TokenType } from '../token/config.js';
import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';

import { normalizeScale, scalesEqual, verifyScale } from './decimals.js';

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
});
