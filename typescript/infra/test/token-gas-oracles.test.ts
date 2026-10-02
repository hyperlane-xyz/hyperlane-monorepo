import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getTokenGasOracleConfigs } from '../config/environments/mainnet3/tokenGasOracles.js';
import { getIgp } from '../config/environments/mainnet3/igp.js';
import gasPrices from '../config/environments/mainnet3/gasPrices.json' with { type: 'json' };
import { supportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import tokenPrices from '../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { tokens } from '../src/config/warp.js';
import {
  getLocalStorageGasOracleConfigOverride,
  getOverheadWithOverrides,
  getTypicalRemoteGasAmount,
} from '../src/config/gas-oracle.js';

const feeTokens = {
  arc: [tokens.arc.USDC],
  arbitrum: [tokens.arbitrum.USDC, tokens.arbitrum.USDT],
  base: [tokens.base.USDC, tokens.base.USDT],
  ethereum: [tokens.ethereum.USDC, tokens.ethereum.USDT],
  ink: [tokens.ink.USDC, tokens.ink.USDT0],
  optimism: [tokens.optimism.USDC, tokens.optimism.USDT],
};

const exchangeRateScale = BigNumber.from(10).pow(10);

describe('mainnet3 stablecoin IGP gas oracles', () => {
  it('configures the selected tokens on six origins for every remote', () => {
    const configs = getTokenGasOracleConfigs();
    expect(Object.keys(configs).sort()).to.deep.equal(
      Object.keys(feeTokens).sort(),
    );
    const igp = getIgp();
    for (const [local, addresses] of Object.entries(feeTokens)) {
      expect(Object.keys(configs[local])).to.deep.equal(addresses);
      expect(igp[local].tokenOracleConfig).to.equal(configs[local]);
      for (const address of addresses) {
        expect(Object.keys(configs[local][address]).sort()).to.deep.equal(
          supportedChainNames.filter((remote) => remote !== local).sort(),
        );
      }
    }
    expect(Object.keys(configs.arc)).to.deep.equal([
      '0x3600000000000000000000000000000000000000',
    ]);
    expect(igp.robinhood.tokenOracleConfig).to.equal(undefined);
  });

  it('prices a remote ETH token in six-decimal dollars without changing remote prices', () => {
    const tokenPrices = { base: '2000', ethereum: '3000' };
    const gasPrices = {
      base: { amount: '1', decimals: 9 },
      ethereum: { amount: '1', decimals: 9 },
    };
    const config = getLocalStorageGasOracleConfigOverride(
      'base',
      ['ethereum'],
      tokenPrices,
      gasPrices,
      () => 0,
      false,
      undefined,
      { price: '1', decimals: 6 },
    ).ethereum;
    const quote = BigNumber.from(config.gasPrice)
      .mul(config.tokenExchangeRate)
      .mul(100_000)
      .div(exchangeRateScale);
    // 100k gas * 1 gwei * $3000/ETH * 1.5 margin = $0.45.
    expect(quote.toString()).to.equal('450000');
    expect(tokenPrices).to.deep.equal({ base: '2000', ethereum: '3000' });
  });

  it('preserves non-round remote prices when scaled exchange rates exceed one', () => {
    const configs = getLocalStorageGasOracleConfigOverride(
      'base',
      ['ethereum', 'subtensor'],
      { base: '2438.28', ethereum: '2438.28', subtensor: '235.68' },
      {
        base: { amount: '1', decimals: 9 },
        ethereum: { amount: '2', decimals: 9 },
        subtensor: { amount: '10', decimals: 9 },
      },
      () => 166_887,
      true,
      undefined,
      { price: '1', decimals: 6 },
    );
    for (const [remote, expectedUsd] of [
      ['ethereum', '1.58649370308'],
      ['subtensor', '0.7667389224'],
    ]) {
      const config = configs[remote];
      const quote = BigNumber.from(config.gasPrice)
        .mul(config.tokenExchangeRate)
        .mul(216_887)
        .div(exchangeRateScale);
      const expected = new BigNumberJs(expectedUsd)
        .times(1_000_000)
        .integerValue(BigNumberJs.ROUND_FLOOR)
        .toFixed(0);
      expect(quote.toString(), remote).to.equal(expected);
    }
  });

  it('preserves the snapshot margin for every selected token on Ethereum and Subtensor lanes', () => {
    const configs = getTokenGasOracleConfigs();
    for (const [local, addresses] of Object.entries(feeTokens)) {
      for (const address of addresses) {
        for (const remote of ['ethereum', 'subtensor'] as const) {
          if (remote === local) continue;
          const config = configs[local][address][remote];
          const gas = getTypicalRemoteGasAmount(
            local,
            remote,
            ProtocolType.Ethereum,
            getOverheadWithOverrides,
          );
          const quote = BigNumber.from(config.gasPrice)
            .mul(config.tokenExchangeRate)
            .mul(gas)
            .div(exchangeRateScale);
          // Both remotes have 18 native decimals; fee payments have 6.
          const expected = new BigNumberJs(gasPrices[remote].amount)
            .times(new BigNumberJs(10).pow(gasPrices[remote].decimals))
            .times(gas)
            .times(tokenPrices[remote])
            .times(1.5)
            .times(new BigNumberJs(10).pow(6 - 18))
            .integerValue(BigNumberJs.ROUND_FLOOR)
            .toFixed(0);
          expect(quote.toString(), `${local}/${address}->${remote}`).to.equal(
            expected,
          );
        }
      }
    }
  });

  it('keeps native-fee gas price and exchange rate unchanged', () => {
    const config = getLocalStorageGasOracleConfigOverride(
      'base',
      ['ethereum'],
      { base: '2438.28', ethereum: '2438.28' },
      {
        base: { amount: '1', decimals: 9 },
        ethereum: { amount: '2', decimals: 9 },
      },
      () => 0,
      false,
    ).ethereum;
    expect(config.gasPrice).to.equal('2000000000');
    expect(config.tokenExchangeRate).to.equal('15000000000');
  });

  it('uses six decimals for Arc fee payments and eighteen for Arc destination gas', () => {
    const tokenPrices = { arc: '1', ethereum: '3000' };
    const gasPrices = {
      arc: { amount: '20', decimals: 9 },
      ethereum: { amount: '1', decimals: 9 },
    };
    const arcOrigin = getLocalStorageGasOracleConfigOverride(
      'arc',
      ['ethereum'],
      tokenPrices,
      gasPrices,
      () => 0,
      false,
      undefined,
      { price: '1', decimals: 6 },
    ).ethereum;
    const arcDestination = getLocalStorageGasOracleConfigOverride(
      'ethereum',
      ['arc'],
      tokenPrices,
      gasPrices,
      () => 0,
      false,
      undefined,
      { price: '1', decimals: 6 },
    ).arc;
    const quote = (config: typeof arcOrigin) =>
      BigNumber.from(config.gasPrice)
        .mul(config.tokenExchangeRate)
        .mul(100_000)
        .div(exchangeRateScale);
    // Arc pays $0.45 in ERC20 USDC for Ethereum delivery, including margin.
    expect(quote(arcOrigin).toString()).to.equal('450000');
    // Arc delivery costs 100k * 20 gwei * $1/native USDC * 1.5 = $0.003.
    expect(quote(arcDestination).toString()).to.equal('3000');
    expect(arcDestination.tokenDecimals).to.equal(18);
  });

  it('keeps the L2 USD floor in stablecoin quotes at low remote gas prices', () => {
    const config = getLocalStorageGasOracleConfigOverride(
      'ethereum',
      ['base'],
      { ethereum: '3000', base: '3000' },
      {
        ethereum: { amount: '1', decimals: 9 },
        base: { amount: '0.000001', decimals: 9 },
      },
      () => 0,
      true,
      undefined,
      { price: '1', decimals: 6 },
    ).base;
    const quote = BigNumber.from(config.gasPrice)
      .mul(config.tokenExchangeRate)
      .mul(50_000)
      .div(exchangeRateScale);
    // Base's native IGP floor also applies when paying in USDC/USDT.
    expect(quote.gte(100_000)).to.equal(true);
    expect(quote.lte(100_100)).to.equal(true);
  });
});
