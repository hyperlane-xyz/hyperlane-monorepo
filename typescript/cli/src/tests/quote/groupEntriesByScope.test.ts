import { expect } from 'chai';

import {
  type StandingWarpQuoteEntry,
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { groupEntriesByScope } from '../../read/warp-quote.js';

const DEST_DOMAIN = 137;
const DEST_CHAIN = 'destchain';

const multiProvider = {
  tryGetChainName: (domain: number) =>
    domain === DEST_DOMAIN ? DEST_CHAIN : null,
};

function makeEntry(expirySec: number): StandingWarpQuoteEntry {
  return {
    scope: {
      destination: DEST_DOMAIN,
      recipient: WILDCARD_BYTES32,
      targetRouter: WARP_TARGET_ROUTER_NONE,
      amount: WARP_QUOTE_AMOUNT_WILDCARD,
    },
    params: { maxFee: 1n, halfAmount: 2n },
    issuedAt: expirySec - 3600,
    expiry: expirySec,
  };
}

describe('groupEntriesByScope', () => {
  it('marks an entry expired when its expiry is in the past', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const past = makeEntry(nowSec - 60);
    const result = groupEntriesByScope([past], multiProvider);
    const entry =
      result[DEST_CHAIN]?.['TARGET_ROUTER_NONE']?.['WILDCARD_RECIPIENT'];
    assert(entry, 'expected entry under DEST_CHAIN/NONE/WILDCARD');
    expect(entry.expired).to.equal(true);
  });

  it('marks an entry not expired when its expiry is in the future', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const future = makeEntry(nowSec + 3600);
    const result = groupEntriesByScope([future], multiProvider);
    const entry =
      result[DEST_CHAIN]?.['TARGET_ROUTER_NONE']?.['WILDCARD_RECIPIENT'];
    assert(entry, 'expected entry under DEST_CHAIN/NONE/WILDCARD');
    expect(entry.expired).to.equal(false);
  });

  it('computes the expired flag independently per entry', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const past = {
      ...makeEntry(nowSec - 60),
      scope: {
        ...makeEntry(nowSec - 60).scope,
        recipient: '0x' + 'aa'.repeat(32),
      },
    };
    const future = {
      ...makeEntry(nowSec + 3600),
      scope: {
        ...makeEntry(nowSec + 3600).scope,
        recipient: '0x' + 'bb'.repeat(32),
      },
    };
    const result = groupEntriesByScope([past, future], multiProvider);
    const byRouter = result[DEST_CHAIN]?.['TARGET_ROUTER_NONE'];
    expect(byRouter?.['0x' + 'aa'.repeat(32)]?.expired).to.equal(true);
    expect(byRouter?.['0x' + 'bb'.repeat(32)]?.expired).to.equal(false);
  });
});
