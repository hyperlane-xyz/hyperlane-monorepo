import { expect } from 'chai';

import type { TokenRouter } from '@hyperlane-xyz/core';

import { TestChainName, testChainMetadata } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { HypERC20App } from './app.js';
import { HypERC20Checker } from './checker.js';
import { TokenType } from './config.js';
import { HypTokenRouterConfig } from './types.js';

describe('HypERC20Checker.checkDecimalConsistency', () => {
  function buildChecker(configMap: ChainMap<HypTokenRouterConfig>) {
    const mp = new MultiProvider(testChainMetadata);
    // We do not exercise app-dependent code paths; a minimal stub suffices.
    const dummyApp = {} as unknown as HypERC20App;
    return new HypERC20Checker(mp, dummyApp, configMap);
  }

  function dummyToken(address: string): TokenRouter {
    return { address } as unknown as TokenRouter;
  }

  const owner = '0x000000000000000000000000000000000000dEaD';
  const mailbox = '0x000000000000000000000000000000000000b001';

  it('does not add violation when decimals are uniform (unscaled)', () => {
    const config: ChainMap<HypTokenRouterConfig> = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
    };

    const checker = buildChecker(config);
    const chainDecimals = {
      [TestChainName.test1]: 18,
      [TestChainName.test2]: 18,
    } as Record<string, number>;

    checker.checkDecimalConsistency(
      TestChainName.test1,
      dummyToken('0x1111111111111111111111111111111111111111'),
      chainDecimals,
      'actual',
      true,
    );

    expect(checker.violations).to.have.length(0);
  });

  it('does not add violation when decimals are non-uniform but correct scale is provided', () => {
    const config: ChainMap<HypTokenRouterConfig> = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 6,
        // 18 -> 6 implies scale 10^(18-6) = 10^12
        scale: 1_000_000_000_000,
      },
    };

    const checker = buildChecker(config);
    const chainDecimals = {
      [TestChainName.test1]: 18,
      [TestChainName.test2]: 6,
    } as Record<string, number>;

    checker.checkDecimalConsistency(
      TestChainName.test1,
      dummyToken('0x2222222222222222222222222222222222222222'),
      chainDecimals,
      'actual',
      true,
    );

    expect(checker.violations).to.have.length(0);
  });

  it('adds violation when decimals are non-uniform and scale is incorrect/missing', () => {
    const config: ChainMap<HypTokenRouterConfig> = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 6,
        scale: 1000, // incorrect
      },
    };

    const checker = buildChecker(config);
    const chainDecimals = {
      [TestChainName.test1]: 18,
      [TestChainName.test2]: 6,
    } as Record<string, number>;

    checker.checkDecimalConsistency(
      TestChainName.test1,
      dummyToken('0x3333333333333333333333333333333333333333'),
      chainDecimals,
      'actual',
      true,
    );

    expect(checker.violations).to.have.length(1);
    expect(checker.violations[0].type).to.equal('TokenDecimalsMismatch');
  });

  it('adds violation when nonEmpty is true and all decimals are undefined', () => {
    const config: ChainMap<Partial<HypTokenRouterConfig>> = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
      },
    };

    const checker = buildChecker(config as ChainMap<HypTokenRouterConfig>);
    const chainDecimals = {
      [TestChainName.test1]: undefined,
      [TestChainName.test2]: undefined,
    } as Record<string, number | undefined>;

    checker.checkDecimalConsistency(
      TestChainName.test1,
      dummyToken('0x4444444444444444444444444444444444444444'),
      chainDecimals,
      'actual',
      true,
    );

    expect(checker.violations).to.have.length(1);
    expect(checker.violations[0].type).to.equal('TokenDecimalsMismatch');
  });

  it('adds violation when some chains define decimals and others do not (nonEmpty=false)', () => {
    const config: ChainMap<Partial<HypTokenRouterConfig>> = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        // decimals omitted
      },
      [TestChainName.test3]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
    };

    const checker = buildChecker(config as ChainMap<HypTokenRouterConfig>);
    const chainDecimals = {
      [TestChainName.test1]: 18,
      [TestChainName.test2]: undefined,
      [TestChainName.test3]: 18,
    } as Record<string, number | undefined>;

    checker.checkDecimalConsistency(
      TestChainName.test1,
      dummyToken('0x5555555555555555555555555555555555555555'),
      chainDecimals,
      'config',
      false,
    );

    expect(checker.violations).to.have.length(1);
    expect(checker.violations[0].type).to.equal('TokenDecimalsMismatch');
  });

  it('adds violation when some chains define decimals and others do not (nonEmpty=true)', () => {
    const config: ChainMap<Partial<HypTokenRouterConfig>> = {
      [TestChainName.test1]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
      [TestChainName.test2]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        // decimals omitted
      },
      [TestChainName.test3]: {
        type: TokenType.native,
        owner,
        mailbox,
        name: 'TKN',
        symbol: 'TKN',
        decimals: 18,
      },
    };

    const checker = buildChecker(config as ChainMap<HypTokenRouterConfig>);
    const chainDecimals = {
      [TestChainName.test1]: 18,
      [TestChainName.test2]: undefined,
      [TestChainName.test3]: 18,
    } as Record<string, number | undefined>;

    checker.checkDecimalConsistency(
      TestChainName.test1,
      dummyToken('0x6666666666666666666666666666666666666666'),
      chainDecimals,
      'actual',
      true,
    );

    expect(checker.violations).to.have.length(1);
    expect(checker.violations[0].type).to.equal('TokenDecimalsMismatch');
  });
});
