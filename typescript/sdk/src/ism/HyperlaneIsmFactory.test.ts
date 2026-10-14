import { expect } from 'chai';
import { ethers } from 'ethers';

import { assertNoSealevelOnlyIsm } from './HyperlaneIsmFactory.js';
import { type IsmConfig, IsmType } from './types.js';

const SOME_ADDRESS = ethers.Wallet.createRandom().address;

describe('assertNoSealevelOnlyIsm', () => {
  it('allows a plain EVM ISM config', () => {
    expect(() =>
      assertNoSealevelOnlyIsm({
        type: IsmType.TRUSTED_RELAYER,
        relayer: SOME_ADDRESS,
      }),
    ).to.not.throw();
  });

  const sealevelOnlyCases: Array<[label: string, config: IsmConfig]> = [
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
    [
      'a top-level routingMessageIdMultisigIsm config',
      {
        type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
        owner: SOME_ADDRESS,
        domains: {
          ethereum: { validators: [SOME_ADDRESS], threshold: 1 },
        },
      },
    ],
    [
      'a routingMessageIdMultisigIsm nested inside an aggregation',
      {
        type: IsmType.AGGREGATION,
        threshold: 2,
        modules: [
          { type: IsmType.TEST_ISM },
          {
            type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
            owner: SOME_ADDRESS,
            domains: {
              ethereum: { validators: [SOME_ADDRESS], threshold: 1 },
            },
          },
        ],
      },
    ],
  ];

  for (const [label, config] of sealevelOnlyCases) {
    it(`rejects ${label}`, () => {
      expect(() => assertNoSealevelOnlyIsm(config)).to.throw(/Sealevel-only/);
    });
  }
});
