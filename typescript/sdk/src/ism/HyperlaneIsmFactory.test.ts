import { expect } from 'chai';
import { ethers } from 'ethers';

import { assertNoNestedCompositeIsm } from './HyperlaneIsmFactory.js';
import { type IsmConfig, IsmType } from './types.js';

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

  const nestedCompositeCases: Array<[label: string, config: IsmConfig]> = [
    [
      'a top-level compositeIsm config',
      {
        type: IsmType.COMPOSITE,
        owner: SOME_ADDRESS,
        root: { type: 'test', accept: true },
      },
    ],
    [
      'a compositeIsm nested inside an aggregation',
      {
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
      },
    ],
    [
      'a compositeIsm nested inside a routing domain',
      {
        type: IsmType.ROUTING,
        owner: SOME_ADDRESS,
        domains: {
          ethereum: {
            type: IsmType.COMPOSITE,
            owner: SOME_ADDRESS,
            root: { type: 'test', accept: true },
          },
        },
      },
    ],
    [
      'a compositeIsm nested inside amountRouting lower/upper',
      {
        type: IsmType.AMOUNT_ROUTING,
        threshold: 100,
        lowerIsm: { type: IsmType.TEST_ISM },
        upperIsm: {
          type: IsmType.COMPOSITE,
          owner: SOME_ADDRESS,
          root: { type: 'test', accept: true },
        },
      },
    ],
  ];

  for (const [label, config] of nestedCompositeCases) {
    it(`rejects ${label}`, () => {
      expect(() => assertNoNestedCompositeIsm(config)).to.throw(
        /Sealevel-only/,
      );
    });
  }
});
