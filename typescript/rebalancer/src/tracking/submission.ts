import {
  TransactionSubmissionError,
  type TransactionSubmissionState,
} from '@hyperlane-xyz/utils';

import { Erc20ApprovalError } from '../bridges/erc20Approve.js';
import type {
  BridgeExecutionOptions,
  PendingApproval,
} from '../interfaces/IExternalBridge.js';

import type { IActionTracker } from './IActionTracker.js';

const submissionStateOrder: Record<TransactionSubmissionState, number> = {
  not_submitted: 0,
  unknown: 1,
  submitted: 2,
};

/** Keep primary transfers and approval attempts distinct; only proven unsubmitted work may retry. */
export async function trackActionSubmission<T>(
  tracker: Pick<
    IActionTracker,
    'updateRebalanceActionExecution' | 'failRebalanceAction'
  >,
  actionId: string,
  execute: (options: BridgeExecutionOptions) => Promise<T>,
): Promise<T> {
  let submissionState: TransactionSubmissionState = 'not_submitted';
  let pendingApproval: PendingApproval | undefined;
  const recordSubmission = async (
    state: TransactionSubmissionState,
    txHash?: string,
  ) => {
    const advances =
      submissionStateOrder[state] >= submissionStateOrder[submissionState];
    if (advances) submissionState = state;
    await tracker.updateRebalanceActionExecution(actionId, {
      submissionState,
      ...(advances && txHash ? { txHash } : {}),
    });
  };
  const options: BridgeExecutionOptions = {
    onSubmissionAttempt: (txHash) => recordSubmission('unknown', txHash),
    onSubmitted: (txHash) => recordSubmission('submitted', txHash),
    onTransferId: async (externalBridgeTransferId) => {
      await tracker.updateRebalanceActionExecution(actionId, {
        externalBridgeTransferId,
      });
    },
    onApproval: async (approval) => {
      pendingApproval = approval;
      await tracker.updateRebalanceActionExecution(actionId, {
        pendingApproval,
      });
    },
  };
  try {
    return await execute(options);
  } catch (error) {
    if (error instanceof Erc20ApprovalError) {
      pendingApproval =
        error.submissionState === 'not_submitted'
          ? undefined
          : {
              txHash: error.txHash,
              token: error.token,
              spender: error.spender,
            };
      await tracker.updateRebalanceActionExecution(actionId, {
        pendingApproval,
        submissionState,
      });
    } else if (error instanceof TransactionSubmissionError) {
      await recordSubmission(error.submissionState, error.txHash);
    } else if (submissionState === 'not_submitted') {
      // An adapter without instrumented submission boundaries cannot prove that it did not send.
      submissionState = 'unknown';
      await tracker.updateRebalanceActionExecution(actionId, {
        submissionState,
      });
    }
    if (submissionState === 'not_submitted' && !pendingApproval)
      await tracker.failRebalanceAction(actionId);
    throw error;
  }
}
