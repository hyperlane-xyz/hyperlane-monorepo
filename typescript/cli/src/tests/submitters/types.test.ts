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

  it('ignores inherited root chain entries during preprocessing', () => {
    const inheritedInput = Object.create({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    });

    const parsed = ExtendedChainSubmissionStrategySchema.parse(inheritedInput);

    expect(parsed[CHAIN]).to.equal(undefined);
  });

  it('ignores inherited submitterOverrides during preprocessing', () => {
    const chainStrategy = Object.create({
      submitterOverrides: {
        [ADDRESS_1]: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          safeAddress: ADDRESS_2,
        },
      },
    });
    chainStrategy.submitter = {
      type: TxSubmitterType.JSON_RPC,
    };

    const input = {
      [CHAIN]: chainStrategy,
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    const parsedChainStrategy = parsed[CHAIN];

    expect(parsedChainStrategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(parsedChainStrategy.submitter.chain).to.equal(CHAIN);
    expect(parsedChainStrategy.submitterOverrides).to.equal(undefined);
  });

  it('fails when submitter exists only on prototype during preprocessing', () => {
    const input = {
      [CHAIN]: Object.create({
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      }),
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });

  it('fails when override submitter exists only on prototype during preprocessing', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: Object.create({
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          }),
        },
      },
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });

  it('fails when ICA override owner and safe address mismatch', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN,
            owner: ADDRESS_1,
            destinationChain: CHAIN,
            internalSubmitter: {
              type: TxSubmitterType.GNOSIS_SAFE,
              chain: CHAIN,
              safeAddress: ADDRESS_2,
            },
          },
        },
      },
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });
});
