import { expect } from 'chai';
import { ethers } from 'ethers';

import { assertNoNestedCompositeIsm } from './HyperlaneIsmFactory.js';
import { IsmType } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;

describe('assertNoNestedCompositeIsm', () => {
  it('allows a plain EVM ISM config', () => {
    expect(() =>
      assertNoNestedCompositeIsm({
        type: IsmType.TRUSTED_RELAYER,
        relayer: SOME_ADDRESS,
      }),
    ).to.not.throw();
  });

  it('rejects a top-level compositeIsm config', () => {
    expect(() =>
      assertNoNestedCompositeIsm({
        type: IsmType.COMPOSITE,
        owner: SOME_ADDRESS,
        root: { type: 'test', accept: true },
      }),
    ).to.throw(/Sealevel-only/);
  });

  it('rejects a compositeIsm nested inside an aggregation', () => {
    expect(() =>
      assertNoNestedCompositeIsm({
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TEST_ISM },
          {
            type: IsmType.COMPOSITE,
            owner: SOME_ADDRESS,
            root: { type: 'test', accept: true },
          },
        ],
      }),
    ).to.throw(/Sealevel-only/);
  });

  it('rejects a compositeIsm nested inside a routing domain', () => {
    expect(() =>
      assertNoNestedCompositeIsm({
        type: IsmType.ROUTING,
        owner: SOME_ADDRESS,
        domains: {
          ethereum: {
            type: IsmType.COMPOSITE,
            owner: SOME_ADDRESS,
            root: { type: 'test', accept: true },
          },
        },
      }),
    ).to.throw(/Sealevel-only/);
  });

  it('rejects a compositeIsm nested inside amountRouting lower/upper', () => {
    expect(() =>
      assertNoNestedCompositeIsm({
        type: IsmType.AMOUNT_ROUTING,
        threshold: 100,
        lowerIsm: { type: IsmType.TEST_ISM },
        upperIsm: {
          type: IsmType.COMPOSITE,
          owner: SOME_ADDRESS,
          root: { type: 'test', accept: true },
        },
      }),
    ).to.throw(/Sealevel-only/);
  });
});
