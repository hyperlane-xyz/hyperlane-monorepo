import { ExternalBridgeType } from '../../config/types.js';
import type { RebalanceAction, RebalanceIntent, Transfer } from '../types.js';

const EXTERNAL_BRIDGE_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(ExternalBridgeType),
);
const REBALANCE_INTENT_STATUSES: ReadonlySet<unknown> = new Set([
  'not_started',
  'in_progress',
  'complete',
  'cancelled',
  'failed',
]);
const EXECUTION_METHODS: ReadonlySet<unknown> = new Set([
  'movable_collateral',
  'inventory',
]);
const REBALANCE_ACTION_STATUSES: ReadonlySet<unknown> = new Set([
  'in_progress',
  'complete',
  'failed',
]);
const ACTION_TYPES: ReadonlySet<unknown> = new Set([
  'rebalance_message',
  'inventory_movement',
  'inventory_deposit',
]);
const BRIDGE_STATUSES: ReadonlySet<unknown> = new Set([
  'pending',
  'complete',
  'failed',
  'not_found',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isExternalBridgeType(value: unknown): boolean {
  return EXTERNAL_BRIDGE_TYPES.has(value);
}

function isExternalExecutionRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.provider === 'string' &&
    typeof value.kind === 'string' &&
    isRecord(value.data)
  );
}

function isTrackedActionBase(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.origin === 'number' &&
    typeof value.destination === 'number' &&
    typeof value.amount === 'bigint' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

export function isTransfer(value: unknown): value is Transfer {
  return (
    isTrackedActionBase(value) &&
    (value.status === 'in_progress' || value.status === 'complete') &&
    typeof value.messageId === 'string' &&
    typeof value.sender === 'string' &&
    typeof value.recipient === 'string'
  );
}

export function isRebalanceIntent(value: unknown): value is RebalanceIntent {
  if (!isTrackedActionBase(value)) return false;

  const validStatus = REBALANCE_INTENT_STATUSES.has(value.status);
  const validExecutionMethod =
    value.executionMethod === undefined ||
    EXECUTION_METHODS.has(value.executionMethod);

  return (
    validStatus &&
    isOptionalString(value.bridge) &&
    isOptionalNumber(value.priority) &&
    isOptionalString(value.strategyType) &&
    validExecutionMethod &&
    (value.externalBridge === undefined ||
      isExternalBridgeType(value.externalBridge))
  );
}

export function isRebalanceAction(value: unknown): value is RebalanceAction {
  if (!isTrackedActionBase(value)) return false;

  const validStatus = REBALANCE_ACTION_STATUSES.has(value.status);
  const validType = ACTION_TYPES.has(value.type);
  const validBridgeStatus =
    value.lastBridgeStatus === undefined ||
    BRIDGE_STATUSES.has(value.lastBridgeStatus);

  return (
    validStatus &&
    validType &&
    typeof value.intentId === 'string' &&
    isOptionalString(value.messageId) &&
    isOptionalString(value.txHash) &&
    isOptionalString(value.destinationTxHash) &&
    isOptionalString(value.externalBridgeTransferId) &&
    (value.externalExecutionRef === undefined ||
      isExternalExecutionRef(value.externalExecutionRef)) &&
    (value.externalBridgeId === undefined ||
      isExternalBridgeType(value.externalBridgeId)) &&
    validBridgeStatus &&
    isOptionalNumber(value.nonPendingSince)
  );
}
