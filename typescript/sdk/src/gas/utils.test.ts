import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  ChainGasOracleParams,
  getLocalStorageGasOracleConfig,
} from './utils.js';

// Fee quote the IGP computes for a message, in the local (fee-token) base unit:
//   quote = gasAmount * gasPrice * tokenExchangeRate / 1e10
const EXCHANGE_RATE_SCALE = 1e10;
const MAX_REBALANCED_QUOTE_ROUNDING_ERROR = 1 / 1000;
function quote(
  config: { gasPrice: string; tokenExchangeRate: string },
  gasAmount: number,
): number {
  return (
    (gasAmount * Number(config.gasPrice) * Number(config.tokenExchangeRate)) /
    EXCHANGE_RATE_SCALE
  );
}

describe('getLocalStorageGasOracleConfig', () => {
  it('leaves same-decimal native pairs unchanged (no rebalance)', () => {
    // local + remote both 18-decimal native tokens; remote worth 2x local.
    const gasOracleParams: Record<string, ChainGasOracleParams> = {
      local: {
        gasPrice: { amount: '1', decimals: 9 },
        nativeToken: { price: '1', decimals: 18 },
      },
      remote: {
        gasPrice: { amount: '1', decimals: 9 }, // 1 gwei = 1e9 wei
        nativeToken: { price: '2', decimals: 18 },
      },
    };

    const config = getLocalStorageGasOracleConfig({
      local: 'local',
      localProtocolType: ProtocolType.Ethereum,
      gasOracleParams,
      exchangeRateMarginPct: 0,
    });

    // exchangeRate = (2/1) * 1e10 ; gasPrice = 1e9 ; both pass through as-is.
    expect(config.remote.tokenExchangeRate).to.equal('20000000000');
    expect(config.remote.gasPrice).to.equal('1000000000');
  });

  it('rebalances a sub-unit exchange rate for a low-decimal fee token', () => {
    // 6-decimal fee token paying for an 18-decimal remote, remote worth 10x.
    // Naively the scaled exchange rate is (10) * 10^(6-18) * 1e10 = 0.1, which
    // would floor to 1 and overprice the quote 10x. The rebalance must keep it
    // representable while preserving the quote.
    const gasOracleParams: Record<string, ChainGasOracleParams> = {
      feeToken: {
        gasPrice: { amount: '1', decimals: 9 },
        nativeToken: { price: '1', decimals: 6 },
      },
      remote: {
        gasPrice: { amount: '50', decimals: 9 }, // 50 gwei = 5e10 wei
        nativeToken: { price: '10', decimals: 18 },
      },
    };

    const config = getLocalStorageGasOracleConfig({
      local: 'feeToken',
      localProtocolType: ProtocolType.Ethereum,
      gasOracleParams,
      exchangeRateMarginPct: 0,
    }).remote;

    // Exchange rate must be representable before integer rounding.
    expect(Number(config.tokenExchangeRate)).to.be.at.least(1);

    // The quote (gasPrice * exchangeRate product) must match the intended value:
    // intended per-gas = 5e10 * 0.1 / 1e10 = 0.5 base units per unit gas.
    const gasAmount = 200_000;
    expect(quote(config, gasAmount)).to.be.approximately(
      0.5 * gasAmount,
      0.5 * gasAmount * MAX_REBALANCED_QUOTE_ROUNDING_ERROR,
    );
  });

  it('preserves precision for non-power-of-ten exchange rates', () => {
    // 6-decimal fee token paying for an 18-decimal remote, remote worth 15x.
    // Naively the scaled exchange rate is 0.15. Shifting only one digit makes
    // this 1.5, which floors to 1 and underquotes by 33%; using all safe
    // gas-price headroom keeps the floor rounding error negligible.
    const gasOracleParams: Record<string, ChainGasOracleParams> = {
      feeToken: {
        gasPrice: { amount: '1', decimals: 9 },
        nativeToken: { price: '1', decimals: 6 },
      },
      remote: {
        gasPrice: { amount: '50', decimals: 9 }, // 50 gwei = 5e10 wei
        nativeToken: { price: '15', decimals: 18 },
      },
    };

    const config = getLocalStorageGasOracleConfig({
      local: 'feeToken',
      localProtocolType: ProtocolType.Ethereum,
      gasOracleParams,
      exchangeRateMarginPct: 0,
    }).remote;

    const gasAmount = 200_000;
    expect(quote(config, gasAmount)).to.be.approximately(
      0.75 * gasAmount,
      0.75 * gasAmount * MAX_REBALANCED_QUOTE_ROUNDING_ERROR,
    );
  });

  it('falls back to the floor when there is no gas price headroom to rebalance', () => {
    // gasPrice in wei (5) is below MIN_REBALANCED_GAS_PRICE, so shifting any
    // magnitude into the exchange rate would exceed the rounding-error bound.
    // This documents the known fallback limitation: the quote is overpriced by
    // the sub-1 exchange rate factor rather than preserving precision.
    const gasOracleParams: Record<string, ChainGasOracleParams> = {
      feeToken: {
        gasPrice: { amount: '1', decimals: 9 },
        nativeToken: { price: '1', decimals: 6 },
      },
      remote: {
        gasPrice: { amount: '5', decimals: 0 }, // <10 wei
        nativeToken: { price: '10', decimals: 18 },
      },
    };

    const config = getLocalStorageGasOracleConfig({
      local: 'feeToken',
      localProtocolType: ProtocolType.Ethereum,
      gasOracleParams,
      exchangeRateMarginPct: 0,
    }).remote;

    expect(config.tokenExchangeRate).to.equal('1');
    expect(config.gasPrice).to.equal('5');
  });

  it('uses a smaller gas price scale when the exchange rate would floor to zero', () => {
    const gasOracleParams: Record<string, ChainGasOracleParams> = {
      local: {
        gasPrice: { amount: '1', decimals: 0 },
        nativeToken: { price: '1', decimals: 18 },
      },
      remote: {
        gasPrice: { amount: '0.5', decimals: 0 },
        nativeToken: { price: '0.0000001', decimals: 18 },
      },
    };

    const config = getLocalStorageGasOracleConfig({
      local: 'local',
      localProtocolType: ProtocolType.Ethereum,
      gasOracleParams,
      exchangeRateMarginPct: 0,
    }).remote;

    expect(config.tokenExchangeRate).to.equal('1');
    expect(config.gasPrice).to.equal('500');
  });
});
