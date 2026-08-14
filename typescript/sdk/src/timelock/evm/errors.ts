import { errors as EthersError } from 'ethers';

import { getNestedJsonRpcError } from '../../providers/SmartProvider/SmartProvider.js';

type EthersCallException = {
  code?: unknown;
  data?: unknown;
  error?: unknown;
};

function asRecord(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  // CAST: runtime object check above narrows enough for keyed inspection.
  return error as Record<string, unknown>;
}

export function isDeterministicTimelockReadError(error: unknown): boolean {
  // CAST: asRecord gates property reads; fields stay unknown until compared.
  const record = asRecord(error) as EthersCallException | undefined;
  if (record?.code !== EthersError.CALL_EXCEPTION) return false;

  const hasRevertData = !!record.data && record.data !== '0x';
  const hasNestedError = !!record.error;
  const jsonRpcErrorCode = getNestedJsonRpcError(error).code;

  return hasRevertData || jsonRpcErrorCode === 3 || !hasNestedError;
}
