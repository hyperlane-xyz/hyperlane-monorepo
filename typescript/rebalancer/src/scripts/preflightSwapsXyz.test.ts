import { expect } from 'chai';

import { SwapsXyzPreflightRequestSchema } from './preflightSwapsXyz.js';

const request = {
  fromChain: 1399811149,
  toChain: 1,
  fromToken: 'source-token',
  toToken: 'destination-token',
  fromAddress: 'public-signer',
};

describe('SwapsXyzPreflightRequestSchema', () => {
  it('accepts public exact-input and exact-output requests', () => {
    expect(
      SwapsXyzPreflightRequestSchema.parse({
        ...request,
        fromAmount: '1000000',
      }).fromAmount,
    ).to.equal(1_000_000n);
    expect(
      SwapsXyzPreflightRequestSchema.parse({ ...request, toAmount: '1000000' })
        .toAmount,
    ).to.equal(1_000_000n);
  });

  it('requires exactly one positive integer amount', () => {
    for (const amounts of [
      {},
      { fromAmount: '1', toAmount: '1' },
      { fromAmount: '0' },
      { fromAmount: '1.5' },
    ]) {
      expect(
        SwapsXyzPreflightRequestSchema.safeParse({ ...request, ...amounts })
          .success,
      ).to.equal(false);
    }
  });

  it('rejects private key fields', () => {
    expect(
      SwapsXyzPreflightRequestSchema.safeParse({
        ...request,
        fromAmount: '1',
        privateKey: 'not-accepted',
      }).success,
    ).to.equal(false);
  });
});
