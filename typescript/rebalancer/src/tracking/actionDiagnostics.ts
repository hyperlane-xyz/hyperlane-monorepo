import type { RebalanceAction } from './types.js';

export const BLOCKED_ACTION_WARNING_AGE_MS = 60 * 60 * 1_000;

export enum ActionHoldReason {
  ApprovalPending = 'approval_pending',
  SourceUnknown = 'source_unknown',
  SourcePending = 'source_pending',
  BridgeFailed = 'bridge_failed',
  BridgeNotFound = 'bridge_not_found',
  SettlementPending = 'settlement_pending',
}

/** Operational classification only; no reason grants permission to release an action. */
export function getActionHoldReason(action: RebalanceAction): ActionHoldReason {
  if (action.pendingApproval) return ActionHoldReason.ApprovalPending;
  if (action.lastBridgeStatus === 'failed')
    return ActionHoldReason.BridgeFailed;
  if (action.lastBridgeStatus === 'not_found')
    return ActionHoldReason.BridgeNotFound;
  if (
    action.messageId ||
    action.externalExecutionRef ||
    (action.finalizedSourceTxHash === action.txHash && action.txHash)
  )
    return ActionHoldReason.SettlementPending;
  if (action.submissionState === 'not_submitted')
    return ActionHoldReason.SourcePending;
  if (action.submissionState !== 'submitted')
    return ActionHoldReason.SourceUnknown;
  return ActionHoldReason.SettlementPending;
}
