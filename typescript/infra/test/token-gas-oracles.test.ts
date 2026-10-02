import { expect } from 'chai';
import { BigNumber } from 'ethers';

import { getTokenGasOracleConfigs } from '../config/environments/mainnet3/tokenGasOracles.js';
import { getIgp } from '../config/environments/mainnet3/igp.js';
import { supportedChainNames } from '../config/environments/mainnet3/supportedChainNames.js';
import { tokens } from '../src/config/warp.js';
import { getLocalStorageGasOracleConfigOverride } from '../src/config/gas-oracle.js';

const feeTokens = {
  arbitrum: [tokens.arbitrum.USDC, tokens.arbitrum.USDT],
  base: [tokens.base.USDC, tokens.base.USDT],
  ethereum: [tokens.ethereum.USDC, tokens.ethereum.USDT],
  optimism: [tokens.optimism.USDC, tokens.optimism.USDT],
};

const exchangeRateScale = BigNumber.from(10).pow(10);

describe('mainnet3 stablecoin IGP gas oracles', () => {
  it('configures both tokens only on the four rollout chains, for every remote', () => {
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
    for (const chain of ['arc', 'ink', 'robinhood']) {
      expect(igp[chain].tokenOracleConfig).to.equal(undefined);
    }
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
