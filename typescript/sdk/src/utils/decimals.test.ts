import { assert } from 'chai';

import { randomAddress } from '../test/testUtils.js';
import { TokenType } from '../token/config.js';
import {
  TokenMetadata,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';

import { verifyScale } from './decimals.js';

describe(verifyScale.name, () => {
  const TOKEN_NAME = 'TOKEN';

  it('should return true when all decimals are uniform', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 18 }],
      ['chain2', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 18 }],
    ]);
    assert.isTrue(verifyScale(configMap));
  });

  it('should return true when all decimals are uniform and scale is not provided', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 6 }],
      ['chain2', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 6 }],
    ]);
    assert.isTrue(verifyScale(configMap));
  });

  it('should return true when decimals are non-uniform but scales are correctly calculated/provided', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 18 }],
      [
        'chain2',
        {
          name: TOKEN_NAME,
          symbol: TOKEN_NAME,
          decimals: 6,
          //scale: 1_000_000_000_000
          scale: 1_000_000_000_000,
        },
      ], // 10^(18-6) = 10^12
    ]);
    assert.isTrue(verifyScale(configMap));
  });

  it('should return false when decimals are non-uniform and an incorrect scale is provided', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 18 }],
      [
        'chain2',
        { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 6, scale: 100 },
      ],
    ]);
    assert.isFalse(verifyScale(configMap));
  });

  it('should return false when decimals are non-uniform and scale is missing', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 18 }],
      ['chain2', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 6 }],
    ]);

    assert.isFalse(verifyScale(configMap));
  });

  it('should throw an error if decimals are not defined for a token config', () => {
    const configMap: Map<string, TokenMetadata> = new Map([
      ['chain1', { name: TOKEN_NAME, symbol: TOKEN_NAME, decimals: 18 }],
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
        decimals: 18,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: 6,
        scale: 1_000_000_000_000,
        mailbox: randomAddress(),
      },
    };
    assert.isTrue(verifyScale(config));
  });

  it('should handle WarpRouteDeployConfigMailboxRequired with uniform decimals', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: 18,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: 18,
        mailbox: randomAddress(),
      },
    };
    assert.isTrue(verifyScale(config));
  });

  it('should return false for WarpRouteDeployConfigMailboxRequired with incorrect scale', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: 18,
        mailbox: randomAddress(),
      },
      chain2: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: 6,
        scale: 1000,
        mailbox: randomAddress(),
      },
    };
    assert.isFalse(verifyScale(config));
  });

  it('should throw an error for WarpRouteDeployConfigMailboxRequired with missing decimals', () => {
    const config: WarpRouteDeployConfigMailboxRequired = {
      chain1: {
        type: TokenType.collateral,
        token: randomAddress(),
        owner: randomAddress(),
        decimals: 18,
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
