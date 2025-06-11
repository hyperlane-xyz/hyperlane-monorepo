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

  // ---------------------------------------------------------------------------
  // Additional edge–case and failure–path tests
  // ---------------------------------------------------------------------------

  describe('edge cases & failure paths', () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
      clock = sinon.useFakeTimers();
    });

    afterEach(() => {
      clock.restore();
    });

    it('handles an empty array of ids gracefully', async () => {
      // Empty fetch should not throw and should resolve to an empty array
      stub?.restore();
      stub = sinon.stub(tokenPriceGetter, 'fetchPriceData').resolves([]);
      expect(await tokenPriceGetter.getTokenPriceByIds([])).to.eql([]);
      sinon.assert.notCalled(stub); // fetchPriceData should short-circuit
    });

    it('throws when fetchPriceData rejects', async () => {
      stub?.restore();
      const err = new Error('network down');
      stub = sinon.stub(tokenPriceGetter, 'fetchPriceData').rejects(err);
      await expect(
        tokenPriceGetter.getTokenPriceByIds([ethereum.name]),
      ).to.be.rejectedWith('network down');
    });

    it('returns undefined for unknown / unsupported chain', async () => {
      expect(await tokenPriceGetter.getTokenPrice('made-up-chain')).to.equal(
        undefined,
      );
    });

    it('returns cached values until expiry then refreshes', async () => {
      // 1) Prime cache
      const [first] = (await tokenPriceGetter.getTokenPriceByIds([
        ethereum.name,
      ]))!;
      expect(first).to.equal(priceA);

      // 2) Change stub so that a different value would be returned if invoked
      stub?.restore();
      const newPrice = 999;
      stub = sinon
        .stub(tokenPriceGetter, 'fetchPriceData')
        .resolves([newPrice]);

      // 3) Immediately read again -> cached value should still be returned
      const [cached] = (await tokenPriceGetter.getTokenPriceByIds([
        ethereum.name,
      ]))!;
      expect(cached).to.equal(priceA);
      sinon.assert.notCalled(stub);

      // 4) Advance fake timer past expirySeconds and read again
      clock.tick(10_000);
      const [refreshed] = (await tokenPriceGetter.getTokenPriceByIds([
        ethereum.name,
      ]))!;
      expect(refreshed).to.equal(newPrice);
      sinon.assert.calledOnce(stub);
    });
  });
});