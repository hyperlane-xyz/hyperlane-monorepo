type EthersCallException = {
  code?: unknown;
  data?: unknown;
  error?: unknown;
};

type JsonRpcError = {
  code?: unknown;
  data?: unknown;
  error?: unknown;
};

function asRecord(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  // CAST: runtime object check above narrows enough for keyed inspection.
  return error as Record<string, unknown>;
}

function nestedJsonRpcError(error: unknown): JsonRpcError | undefined {
  const record = asRecord(error);
  const nested = asRecord(record?.error);
  // CAST: only optional JSON-RPC error fields are inspected.
  return nested as JsonRpcError | undefined;
}

export function isDeterministicTimelockReadError(error: unknown): boolean {
  // CAST: asRecord gates property reads; fields stay unknown until compared.
  const record = asRecord(error) as EthersCallException | undefined;
  if (record?.code !== 'CALL_EXCEPTION') return false;

  const nested = nestedJsonRpcError(error);
  const hasRevertData = !!record.data && record.data !== '0x';
  const hasNestedError = !!record.error;
  const jsonRpcErrorCode = nested?.code;

  return hasRevertData || jsonRpcErrorCode === 3 || !hasNestedError;
}
