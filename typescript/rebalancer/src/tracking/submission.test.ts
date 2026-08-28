import { expect } from 'chai';
import sinon from 'sinon';

import {
  TransactionSubmission,
  TransactionSubmissionError,
} from '@hyperlane-xyz/utils';

import { Erc20ApprovalError } from '../bridges/erc20Approve.js';

import { trackActionSubmission } from './submission.js';

describe('action submission tracking', () => {
  function tracker() {
    return {
      updateRebalanceActionExecution: sinon.stub().resolves(),
      failRebalanceAction: sinon.stub().resolves(),
    };
  }
  async function rejection(operation: Promise<unknown>) {
    try {
      await operation;
    } catch (error) {
      return error;
    }
    throw new Error('Expected rejection');
  }

  it('releases an action when preparation proves no submission occurred', async () => {
    const t = tracker();
    const error = new TransactionSubmissionError(
      new Error('invalid payload'),
      'not_submitted',
    );
    expect(
      await rejection(
        trackActionSubmission(t, 'action', async () => {
          throw error;
        }),
      ),
    ).to.equal(error);
    expect(t.failRebalanceAction.calledOnceWithExactly('action')).to.equal(
      true,
    );
  });

  it('records a locally signed hash before the RPC and reserves a lost response', async () => {
    const t = tracker();
    const send = sinon.stub().rejects(new Error('lost response'));
    await rejection(
      trackActionSubmission(t, 'action', async (options) =>
        new TransactionSubmission(options).submit(
          send,
          (hash: string) => hash,
          'signed-hash',
        ),
      ),
    );
    expect(
      t.updateRebalanceActionExecution.firstCall.calledBefore(send.firstCall),
    ).to.equal(true);
    expect(t.updateRebalanceActionExecution.lastCall.args[1]).to.include({
      txHash: 'signed-hash',
      submissionState: 'unknown',
    });
    expect(t.failRebalanceAction.called).to.equal(false);
  });

  it('preserves an acknowledged source hash if later confirmation fails', async () => {
    const t = tracker();
    await rejection(
      trackActionSubmission(t, 'action', async (options) => {
        const submission = new TransactionSubmission(options);
        return submission.run(async () => {
          await submission.submit(
            async () => 'source-hash',
            (hash) => hash,
          );
          throw new Error('receipt timeout');
        });
      }),
    );
    expect(t.updateRebalanceActionExecution.lastCall.args[1]).to.include({
      txHash: 'source-hash',
      submissionState: 'submitted',
    });
    expect(t.failRebalanceAction.called).to.equal(false);
  });

  it('keeps approval identity separate and does not release work while approval is ambiguous', async () => {
    const t = tracker();
    await rejection(
      trackActionSubmission(t, 'action', async (options) => {
        await options.onApproval?.({ txHash: 'approval-hash' });
        throw new Erc20ApprovalError(
          new Error('receipt timeout'),
          'submitted',
          'approval-hash',
          'token',
          'spender',
        );
      }),
    );
    const update = t.updateRebalanceActionExecution.lastCall.args[1];
    expect(update).to.deep.equal({
      pendingApproval: {
        txHash: 'approval-hash',
        token: 'token',
        spender: 'spender',
      },
      submissionState: 'not_submitted',
    });
    expect(
      t.updateRebalanceActionExecution
        .getCalls()
        .some((call) => call.args[1].txHash !== undefined),
    ).to.equal(false);
    expect(t.failRebalanceAction.called).to.equal(false);
  });

  it('releases a failed pre-broadcast approval and retains uninstrumented ambiguity', async () => {
    const t = tracker();
    await rejection(
      trackActionSubmission(t, 'action', async () => {
        throw new Erc20ApprovalError(
          new Error('prepare'),
          'not_submitted',
          undefined,
        );
      }),
    );
    expect(t.failRebalanceAction.calledOnce).to.equal(true);
    t.failRebalanceAction.resetHistory();
    await rejection(
      trackActionSubmission(t, 'action', async () => {
        throw new Error('uninstrumented adapter failure');
      }),
    );
    expect(t.failRebalanceAction.called).to.equal(false);
  });
});
