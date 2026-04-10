import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import {
  CustomTxSubmitterType,
  ExtendedChainSubmissionStrategySchema,
} from './types.js';

describe('ExtendedChainSubmissionStrategySchema', () => {
  it('preserves malformed strategy entries for zod validation', () => {
    const result = ExtendedChainSubmissionStrategySchema.safeParse({
      ethereum: {},
    });

    expect(result.success).to.equal(false);
  });

  it('fills missing file submitter chain from strategy chain', () => {
    const strategy = ExtendedChainSubmissionStrategySchema.parse({
      ethereum: {
        submitter: {
          type: CustomTxSubmitterType.FILE,
          filepath: '/tmp/transactions.yaml',
        },
      },
    });

    expect(strategy.ethereum.submitter).to.deep.equal({
      type: CustomTxSubmitterType.FILE,
      filepath: '/tmp/transactions.yaml',
      chain: 'ethereum',
    });
  });

  it('rejects file submitter chain mismatch', () => {
    const result = ExtendedChainSubmissionStrategySchema.safeParse({
      ethereum: {
        submitter: {
          type: CustomTxSubmitterType.FILE,
          filepath: '/tmp/transactions.yaml',
          chain: 'arbitrum',
        },
      },
    });

    expect(result.success).to.equal(false);
  });

  it('preserves submitter refs without resolving them', () => {
    const strategy = ExtendedChainSubmissionStrategySchema.parse({
      ethereum: {
        submitter: {
          type: TxSubmitterType.SUBMITTER_REF,
          ref: 'submitters/ethereum',
        },
      },
    });

    expect(strategy.ethereum.submitter).to.deep.equal({
      type: TxSubmitterType.SUBMITTER_REF,
      ref: 'submitters/ethereum',
    });
  });
});
