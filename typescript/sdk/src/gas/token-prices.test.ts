import { expect } from 'chai';
import sinon from 'sinon';

import { ethereum, solanamainnet } from '@hyperlane-xyz/registry';

import { TestChainName, testChainMetadata } from '../consts/testChains.js';

import { CoinGeckoTokenPriceGetter } from './token-prices.js';

const MOCK_FETCH_CALLS = true;

describe('TokenPriceGetter', () => {
  let tokenPriceGetter: CoinGeckoTokenPriceGetter;

  const chainA = TestChainName.test1;
  const chainB = TestChainName.test2;
  const priceA = 2;
  const priceB = 5;
  let stub: sinon.SinonStub;

  beforeEach(() => {
    tokenPriceGetter = new CoinGeckoTokenPriceGetter({
      // @ts-ignore TODO: remove once merged with main
      chainMetadata: { ethereum, solanamainnet, ...testChainMetadata },
      apiKey: 'test',
      expirySeconds: 10,
      sleepMsBetweenRequests: 10,
    });

    if (MOCK_FETCH_CALLS) {
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .returns(Promise.resolve([priceA, priceB]));
    }
  });

  afterEach(() => {
    if (MOCK_FETCH_CALLS && stub) {
      stub.restore();
    }
  });

  describe('getTokenPriceByIds', () => {
    it('returns token prices', async () => {
      // stubbed results
      expect(
        await tokenPriceGetter.getTokenPriceByIds([
          ethereum.name,
          solanamainnet.name,
        ]),
      ).to.eql([priceA, priceB]);
    });
  });

  describe('getTokenPrice', () => {
    it('returns a token price', async () => {
      // hardcoded result of 1 for testnets
      expect(
        await tokenPriceGetter.getTokenPrice(TestChainName.test1),
      ).to.equal(1);
      // stubbed result for non-testnet
      expect(await tokenPriceGetter.getTokenPrice(ethereum.name)).to.equal(
        priceA,
      );
    });
  });

  describe('getTokenExchangeRate', () => {
    it('returns a value consistent with getTokenPrice()', async () => {
      // hardcoded result of 1 for testnets
      expect(
        await tokenPriceGetter.getTokenExchangeRate(chainA, chainB),
      ).to.equal(1);

      // stubbed result for non-testnet
      expect(
        await tokenPriceGetter.getTokenExchangeRate(
          ethereum.name,
          solanamainnet.name,
        ),
      ).to.equal(priceA / priceB);
    });
  });
});
