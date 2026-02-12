import { assert, expect } from 'chai';

import { randomAddress } from '../test/testUtils.js';
import { TokenType } from '../token/config.js';
import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';

import { scaleToScalar, verifyScale } from './decimals.js';

describe(scaleToScalar.name, () => {
  it('should return 1 for undefined', () => {
    expect(scaleToScalar(undefined)).to.equal(1);
  });

  it('should return the number directly for numeric scale', () => {
    expect(scaleToScalar(1_000_000_000_000)).to.equal(1_000_000_000_000);
    expect(scaleToScalar(1)).to.equal(1);
  });

  it('should parse string scale', () => {
    expect(scaleToScalar('1000000000000')).to.equal(1_000_000_000_000);
    expect(scaleToScalar('1')).to.equal(1);
  });

  it('should compute numerator / denominator for fractional scale', () => {
    expect(
      scaleToScalar({ numerator: 1_000_000_000_000, denominator: 1 }),
    ).to.equal(1_000_000_000_000);
    expect(
      scaleToScalar({ numerator: 1, denominator: 1_000_000_000_000 }),
    ).to.equal(1e-12);
    expect(scaleToScalar({ numerator: 1, denominator: 1 })).to.equal(1);
  });

  it('should handle string numerator and denominator', () => {
    expect(
      scaleToScalar({ numerator: '1000000000000', denominator: '1' }),
    ).to.equal(1_000_000_000_000);
  });

  it('should treat legacy integer scale as equivalent to {numerator: scale, denominator: 1}', () => {
    const legacy = 1_000_000_000_000;
    const fractional = { numerator: 1_000_000_000_000, denominator: 1 };
    expect(scaleToScalar(legacy)).to.equal(scaleToScalar(fractional));
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

  it('should return true when decimals are non-uniform but scales are correctly calculated/provided', () => {
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
