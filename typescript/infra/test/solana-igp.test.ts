import { expect } from 'chai';

import { getIgp } from '../config/environments/mainnet3/igp.js';
import tokenPrices from '../config/environments/mainnet3/tokenPrices.json' with { type: 'json' };

describe('Solana delivery pricing', () => {
  it('quotes $0.25 for a 300k-CU handler on the maintained native EVM lanes', () => {
    const igp = getIgp();
    for (const origin of [
      'arbitrum',
      'base',
      'bsc',
      'ethereum',
      'fluent',
      'galactica',
      'hyperevm',
      'polygon',
    ] as const) {
      const config = igp[origin];
      const oracle = config.oracleConfig.solanamainnet;
      expect(config.overhead.solanamainnet).to.equal(600_000);
      const quote =
        (900_000n *
          BigInt(oracle.gasPrice.toString()) *
          BigInt(oracle.tokenExchangeRate.toString())) /
        10n ** 10n;
      const quoteUsd = (Number(quote) / 1e18) * Number(tokenPrices[origin]);
      expect(quoteUsd, origin).to.be.within(0.2499, 0.2501);
    }
  });
});
