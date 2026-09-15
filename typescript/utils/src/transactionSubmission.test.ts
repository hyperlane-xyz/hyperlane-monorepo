import { expect } from 'chai';
import {
  TransactionSubmission,
  TransactionSubmissionError,
} from './transactionSubmission.js';

describe('TransactionSubmission', () => {
  async function failure(operation: () => Promise<unknown>) {
    try {
      await operation();
    } catch (error) {
      expect(error).to.be.instanceOf(TransactionSubmissionError);
      if (error instanceof TransactionSubmissionError) return error;
    }
    throw new Error('Expected a submission failure');
  }

  it('classifies preparation errors as definitely unsubmitted', async () => {
    const error = await failure(() =>
      new TransactionSubmission().run(async () => {
        throw new Error('bad quote');
      }),
    );
    expect(error.submissionState).to.equal('not_submitted');
  });

  it('retains a locally known hash when the broadcast response is lost', async () => {
    const error = await failure(() =>
      new TransactionSubmission().submit(
        async () => {
          throw new Error('connection lost');
        },
        String,
        'signed-hash',
      ),
    );
    expect(error.submissionState).to.equal('unknown');
    expect(error.txHash).to.equal('signed-hash');
  });

  it('records identity before a confirmation error', async () => {
    const seen: string[] = [];
    const submission = new TransactionSubmission({
      onSubmissionAttempt: () => {
        seen.push('attempt');
      },
      onSubmitted: (hash) => {
        seen.push(hash);
      },
    });
    const error = await failure(() =>
      submission.run(async () => {
        await submission.submit(async () => 'source-hash', String);
        throw new Error('receipt unavailable');
      }),
    );
    expect(seen).to.deep.equal(['attempt', 'source-hash']);
    expect(error.submissionState).to.equal('submitted');
    expect(error.txHash).to.equal('source-hash');
  });

  it('does not broadcast when recording the attempt fails', async () => {
    let sent = false;
    const submission = new TransactionSubmission({
      onSubmissionAttempt: () => {
        throw new Error('cannot record');
      },
    });
    const error = await failure(() =>
      submission.submit(async () => {
        sent = true;
        return 'hash';
      }, String),
    );
    expect(sent).to.equal(false);
    expect(error.submissionState).to.equal('not_submitted');
  });

  it('retains identity when the submitted callback fails', async () => {
    const submission = new TransactionSubmission({
      onSubmitted: () => {
        throw new Error('cannot update');
      },
    });
    const error = await failure(() =>
      submission.submit(async () => 'source-hash', String),
    );
    expect(error.submissionState).to.equal('submitted');
    expect(error.txHash).to.equal('source-hash');
  });
});
