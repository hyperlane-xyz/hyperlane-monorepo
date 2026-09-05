import { expect } from 'chai';
import { pino } from 'pino';
import Sinon from 'sinon';

import { CoinGeckoTokenPriceGetter } from '@hyperlane-xyz/sdk';

import { PriceGetter } from './PriceGetter.js';

const logger = pino({ level: 'silent' });
const response = (price = 1) =>
  new Response(
    JSON.stringify({
      'usd-coin': { usd: price },
      tether: { usd: price },
    }),
  );

describe('PriceGetter concurrent lookups', () => {
  afterEach(() => Sinon.restore());

  it('reduces twelve concurrent same-ID HTTP requests to one', async () => {
    const fetch = Sinon.stub(globalThis, 'fetch').callsFake(async () =>
      response(),
    );
    const baseline = new CoinGeckoTokenPriceGetter({
      chainMetadata: {},
      sleepMsBetweenRequests: 0,
    });
    const before = await Promise.all(
      Array.from({ length: 12 }, () =>
        baseline.getTokenPriceByIds(['usd-coin']),
      ),
    );
    expect(fetch.callCount).to.equal(12);
    fetch.resetHistory();

    const getter = PriceGetter.create({}, logger, undefined, undefined, 0);
    const after = await Promise.all(
      Array.from({ length: 12 }, () => getter.getCoingeckoPrice('usd-coin')),
    );
    expect(fetch.callCount).to.equal(1);
    expect(after).to.deep.equal(before.map((prices) => prices?.[0]));
  });

  it('looks up distinct IDs independently', async () => {
    const fetch = Sinon.stub(globalThis, 'fetch').callsFake(async () =>
      response(),
    );
    const getter = PriceGetter.create({}, logger, undefined, undefined, 0);
    expect(
      await Promise.all([
        getter.getCoingeckoPrice('usd-coin'),
        getter.getCoingeckoPrice('tether'),
        getter.getCoingeckoPrice('usd-coin'),
        getter.getCoingeckoPrice('tether'),
      ]),
    ).to.deep.equal([1, 1, 1, 1]);
    expect(fetch.callCount).to.equal(2);
  });

  it('keeps the SDK cache behavior after a successful lookup', async () => {
    const fetch = Sinon.stub(globalThis, 'fetch').callsFake(async () =>
      response(),
    );
    const getter = PriceGetter.create({}, logger, undefined, 60, 0);
    expect(await getter.getCoingeckoPrice('usd-coin')).to.equal(1);
    expect(await getter.getCoingeckoPrice('usd-coin')).to.equal(1);
    expect(fetch.callCount).to.equal(1);
  });

  it('does not retain settled results beyond the SDK cache lifetime', async () => {
    const fetch = Sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().resolves(response(1));
    fetch.onSecondCall().resolves(response(2));
    const getter = PriceGetter.create({}, logger, undefined, 0, 0);
    expect(await getter.getCoingeckoPrice('usd-coin')).to.equal(1);
    expect(await getter.getCoingeckoPrice('usd-coin')).to.equal(2);
    expect(fetch.callCount).to.equal(2);
  });

  it('retries after an unavailable price instead of retaining undefined', async () => {
    const fetch = Sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().resolves(new Response('{}'));
    fetch.onSecondCall().resolves(response());
    const getter = PriceGetter.create({}, logger, undefined, undefined, 0);
    expect(
      await Promise.all([
        getter.getCoingeckoPrice('usd-coin'),
        getter.getCoingeckoPrice('usd-coin'),
      ]),
    ).to.deep.equal([undefined, undefined]);
    expect(await getter.getCoingeckoPrice('usd-coin')).to.equal(1);
    expect(fetch.callCount).to.equal(2);
  });

  it('propagates rejected lookups to all callers and allows a retry', async () => {
    const getter = PriceGetter.create({}, logger);
    const lookup = Sinon.stub(getter, 'getTokenPriceByIds');
    const error = new Error('price lookup rejected');
    lookup.onFirstCall().rejects(error);
    lookup.onSecondCall().resolves([2]);
    const results = await Promise.allSettled([
      getter.getCoingeckoPrice('usd-coin'),
      getter.getCoingeckoPrice('usd-coin'),
    ]);
    expect(results).to.deep.equal([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(await getter.getCoingeckoPrice('usd-coin')).to.equal(2);
    expect(lookup.callCount).to.equal(2);
  });
});
