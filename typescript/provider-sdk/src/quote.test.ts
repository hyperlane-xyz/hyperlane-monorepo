import { expect } from 'chai';

import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
  WILDCARD_DESTINATION_DOMAIN,
  WarpQuoteAmountKind,
  enumerateWarpQuoteCandidates,
} from './quote.js';
import { DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY } from './warp.js';

const routerA = '0x' + 'aa'.repeat(32);
const routerB = '0x' + 'bb'.repeat(32);

describe('enumerateWarpQuoteCandidates', () => {
  it('returns empty when no routers are known', () => {
    expect(
      enumerateWarpQuoteCandidates({ knownRoutersPerDomain: {} }),
    ).to.deep.equal([]);
  });

  it('emits Leaf/Routing, CC-recipient, and CC-wildcard-recipient scopes per (domain, router)', () => {
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: { 1: new Set([routerA]) },
    });
    expect(got).to.deep.equal([
      // Per-router: Leaf/Routing scope, recipient = router
      {
        destination: 1,
        recipient: routerA,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      // Per-router: CC scope, target_router = router, recipient = router
      {
        destination: 1,
        recipient: routerA,
        targetRouter: routerA,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      // Per-router: CC scope, target_router = router, wildcard recipient
      {
        destination: 1,
        recipient: WILDCARD_BYTES32,
        targetRouter: routerA,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      // Per-domain: Leaf/Routing scope, wildcard recipient
      {
        destination: 1,
        recipient: WILDCARD_BYTES32,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      // Wildcard destination, specific recipient (EVM (*, recipient) cascade)
      {
        destination: WILDCARD_DESTINATION_DOMAIN,
        recipient: routerA,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
    ]);
  });

  it('unions all known routers in the wildcard-destination section', () => {
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: {
        1: new Set([routerA]),
        137: new Set([routerB]),
      },
    });
    const wildcardDestRecipients = got
      .filter((s) => s.destination === WILDCARD_DESTINATION_DOMAIN)
      .map((s) => s.recipient)
      .sort();
    expect(wildcardDestRecipients).to.deep.equal([routerA, routerB].sort());
  });

  it('dedups routers shared across multiple domains in the wildcard-destination section', () => {
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: {
        1: new Set([routerA]),
        137: new Set([routerA]),
      },
    });
    const wildcardDestRows = got.filter(
      (s) => s.destination === WILDCARD_DESTINATION_DOMAIN,
    );
    expect(wildcardDestRows).to.have.lengthOf(1);
    expect(wildcardDestRows[0].recipient).to.equal(routerA);
  });

  it('every emitted candidate has wildcard amount (standing-quote invariant)', () => {
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: { 1: new Set([routerA]) },
    });
    expect(
      got.every((s) => s.amount.kind === WarpQuoteAmountKind.wildcard),
    ).to.equal(true);
  });

  it('never emits a fully-wildcarded scope (destination AND recipient both wildcard)', () => {
    // Adversarial input: caller passes WILDCARD_BYTES32 as a "router" address.
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: {
        1: new Set([routerA]),
        137: new Set([WILDCARD_BYTES32]),
      },
    });
    const fullyWild = got.filter(
      (s) =>
        s.destination === WILDCARD_DESTINATION_DOMAIN &&
        s.recipient === WILDCARD_BYTES32,
    );
    expect(fullyWild).to.deep.equal([]);
  });

  it('never emits DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY as a recipient, but keeps it as targetRouter', () => {
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: {
        1: new Set([routerA, DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]),
      },
    });
    const asRecipient = got.filter(
      (s) => s.recipient === DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY,
    );
    expect(asRecipient).to.deep.equal([]);
    const asTargetRouter = got.filter(
      (s) => s.targetRouter === DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY,
    );
    expect(asTargetRouter.length).to.be.greaterThan(0);
  });

  it('emits no duplicate (destination, recipient, targetRouter, amount) tuples', () => {
    const got = enumerateWarpQuoteCandidates({
      knownRoutersPerDomain: {
        1: new Set([routerA, routerB]),
        137: new Set([routerA]),
      },
    });
    const keys = got.map(
      (s) =>
        `${s.destination}|${s.recipient}|${s.targetRouter}|${
          s.amount.kind === WarpQuoteAmountKind.wildcard
            ? 'w'
            : `v:${s.amount.value}`
        }`,
    );
    expect(new Set(keys).size).to.equal(keys.length);
  });
});
