import { expect } from 'chai';

import { TxSubmitterType } from './TxSubmitterTypes.js';
import {
  parseSubmitterReferencePayload,
  resolveSubmissionStrategy,
  resolveSubmitterMetadata,
} from './reference.js';

describe('submitter references', () => {
  it('resolves submitter metadata from a lookup payload', async () => {
    const submitter = await resolveSubmitterMetadata(
      {
        type: TxSubmitterType.SUBMITTER_REF,
        ref: 'mock://registry/submitters/rebalancer',
      },
      {
        getSubmitter: async () => ({
          type: TxSubmitterType.JSON_RPC,
          chain: 'ethereum',
          userAddress: '0x1111111111111111111111111111111111111111',
          privateKey:
            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
      },
    );

    expect(submitter).to.deep.equal({
      type: TxSubmitterType.JSON_RPC,
      chain: 'ethereum',
      userAddress: '0x1111111111111111111111111111111111111111',
      privateKey:
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('resolves submission strategies from lookup payloads', async () => {
    const strategy = await resolveSubmissionStrategy(
      {
        submitter: {
          type: TxSubmitterType.SUBMITTER_REF,
          ref: 'mock://registry/submitters/rebalancer',
        },
      },
      {
        getSubmitter: async () => ({
          submitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: 'ethereum',
            userAddress: '0x1111111111111111111111111111111111111111',
            privateKey:
              '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        }),
      },
      'ethereum',
    );

    expect(strategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    if (strategy.submitter.type !== TxSubmitterType.JSON_RPC) {
      throw new Error('Expected jsonRpc submitter');
    }
    expect(strategy.submitter.chain).to.equal('ethereum');
    expect(strategy.submitter.privateKey).to.equal(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
  });

  it('rejects submitter refs that resolve to a different chain', async () => {
    try {
      await resolveSubmissionStrategy(
        {
          submitter: {
            type: TxSubmitterType.SUBMITTER_REF,
            ref: 'mock://registry/submitters/rebalancer',
          },
        },
        {
          getSubmitter: async () => ({
            type: TxSubmitterType.JSON_RPC,
            chain: 'arbitrum',
          }),
        },
        'ethereum',
      );
      throw new Error('Expected resolveSubmissionStrategy to fail');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Submitter reference resolved to chain arbitrum, expected ethereum',
      );
    }
  });

  it('throws when a submitter lookup is missing', async () => {
    try {
      await resolveSubmissionStrategy(
        {
          submitter: {
            type: TxSubmitterType.SUBMITTER_REF,
            ref: 'submitters/dev-ethereum',
          },
        },
        {
          getSubmitter: async () => null,
        },
        'ethereum',
      );
      throw new Error('Expected resolveSubmissionStrategy to fail');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Submitter reference submitters/dev-ethereum was not found',
      );
    }
  });

  it('throws when a lookup payload is malformed', async () => {
    try {
      await resolveSubmissionStrategy(
        {
          submitter: {
            type: TxSubmitterType.SUBMITTER_REF,
            ref: 'submitters/dev-ethereum',
          },
        },
        {
          getSubmitter: async () => ({ type: 'not-a-submitter' }),
        },
        'ethereum',
      );
      throw new Error('Expected resolveSubmissionStrategy to fail');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Submitter reference submitters/dev-ethereum did not resolve to SubmitterMetadata or SubmissionStrategy',
      );
    }
  });

  it('propagates parse errors from lookup payloads', async () => {
    try {
      await resolveSubmissionStrategy(
        {
          submitter: {
            type: TxSubmitterType.SUBMITTER_REF,
            ref: 'submitters/dev-ethereum',
          },
        },
        {
          getSubmitter: () =>
            parseSubmitterReferencePayload(
              'type: [',
              'submitters/dev-ethereum.yaml',
            ),
        },
        'ethereum',
      );
      throw new Error('Expected resolveSubmissionStrategy to fail');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Failed to parse submitter reference payload',
      );
    }
  });

  it('throws when no lookup is provided', async () => {
    try {
      await resolveSubmissionStrategy(
        {
          submitter: {
            type: TxSubmitterType.SUBMITTER_REF,
            ref: 'submitters/dev-ethereum',
          },
        },
        undefined,
        'ethereum',
      );
      throw new Error('Expected resolveSubmissionStrategy to fail');
    } catch (error) {
      expect((error as Error).message).to.include(
        'Submitter reference submitters/dev-ethereum requires a submitter lookup',
      );
    }
  });
});
