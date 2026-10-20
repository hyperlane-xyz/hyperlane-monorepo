import { expect } from 'chai';

import { ChainMap } from '@hyperlane-xyz/sdk';

import { getIgp } from '../config/environments/mainnet3/igp.js';
import tokenPrices from '../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };
import { MOONPAY_ROUTE_CHAINS } from '../config/environments/mainnet3/warp/configGetters/moonpay.js';

const prices: ChainMap<string> = tokenPrices;

describe('Solana delivery pricing', () => {
  it('quotes $0.25 for every MoonPay origin and maintained native EVM lane at 900k CU', () => {
    const igp = getIgp();
    const origins = new Set([
      ...MOONPAY_ROUTE_CHAINS.filter((chain) => chain !== 'solanamainnet'),
      'arbitrum',
      'base',
      'bsc',
      'ethereum',
      'fluent',
      'galactica',
      'hyperevm',
      'polygon',
    ]);
    for (const origin of origins) {
      const config = igp[origin];
      const oracle = config.oracleConfig.solanamainnet;
      expect(config.overhead.solanamainnet).to.equal(600_000);
      const quote =
        (900_000n *
          BigInt(oracle.gasPrice.toString()) *
          BigInt(oracle.tokenExchangeRate.toString())) /
        10n ** 10n;
      const quoteUsd = (Number(quote) / 1e18) * Number(prices[origin]);
      expect(quoteUsd, origin).to.be.within(0.2499, 0.2501);
    }
  });
});
