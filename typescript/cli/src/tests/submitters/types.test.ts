import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import { ExtendedChainSubmissionStrategySchema } from '../../submitters/types.js';

describe('ExtendedChainSubmissionStrategySchema', () => {
  const CHAIN = 'ethereum';
  const ADDRESS_1 = '0x1234567890123456789012345678901234567890';
  const ADDRESS_2 = '0x9876543210987654321098765432109876543210';

  it('preprocesses submitterOverrides with inferred chain fields', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            safeAddress: ADDRESS_2,
          },
        },
      },
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    const chainStrategy = parsed[CHAIN];

    expect(chainStrategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(chainStrategy.submitter.chain).to.equal(CHAIN);

    const override = chainStrategy.submitterOverrides?.[ADDRESS_1] as Extract<
      typeof chainStrategy.submitter,
      { type: TxSubmitterType.GNOSIS_TX_BUILDER }
    >;
    expect(override).to.exist;
    expect(override.type).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
    expect(override.chain).to.equal(CHAIN);
    expect(override.version).to.equal('1.0');
  });

  it('preprocesses nested ICA override internal submitter defaults', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN,
            owner: ADDRESS_2,
            internalSubmitter: {
              type: TxSubmitterType.JSON_RPC,
            },
          },
        },
      },
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    const override = parsed[CHAIN].submitterOverrides?.[ADDRESS_1] as Extract<
      (typeof parsed)[typeof CHAIN]['submitter'],
      { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
    >;

    expect(override.type).to.equal(TxSubmitterType.INTERCHAIN_ACCOUNT);
    expect(override.destinationChain).to.equal(CHAIN);
    expect(override.internalSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(override.internalSubmitter.chain).to.equal(CHAIN);
  });
});
