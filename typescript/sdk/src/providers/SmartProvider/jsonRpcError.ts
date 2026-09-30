import { errors as EthersError } from 'ethers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getJsonRpcErrorCode(value: unknown): number | string | undefined {
  if (!isRecord(value)) return undefined;
  const code = value.code;
  return typeof code === 'number' || typeof code === 'string'
    ? code
    : undefined;
}

function getJsonRpcErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.message === 'string' ? value.message : undefined;
}

function getJsonRpcErrorData(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.data === 'string' ? value.data : undefined;
}

function parseJsonRpcErrorBody(body: unknown): {
  code?: number | string;
  message?: string;
  data?: string;
} {
  if (typeof body !== 'string') return {};
  try {
    const parsed = getRecord(JSON.parse(body));
    const error = getRecord(parsed?.error);
    return {
      code: getJsonRpcErrorCode(error),
      message: getJsonRpcErrorMessage(error),
      data: getJsonRpcErrorData(error),
    };
  } catch {
    return {};
  }
}

export function getNestedJsonRpcError(error: unknown): {
  code?: number | string;
  message?: string;
  data?: string;
} {
  const nested = getRecord(getRecord(error)?.error);
  const nestedError = getRecord(nested?.error);
  const nestedBody = parseJsonRpcErrorBody(nested?.body);
  return {
    code:
      getJsonRpcErrorCode(nestedError) ??
      getJsonRpcErrorCode(nested) ??
      nestedBody.code,
    message:
      getJsonRpcErrorMessage(nestedError) ??
      getJsonRpcErrorMessage(nested) ??
      nestedBody.message,
    data:
      getJsonRpcErrorData(nestedError) ??
      getJsonRpcErrorData(nested) ??
      nestedBody.data,
  };
}

export function isCallExceptionWithTransientRpcError(error: unknown): boolean {
  const record = getRecord(error);
  if (record?.code !== EthersError.CALL_EXCEPTION) return false;
  const hasRevertData = !!record.data && record.data !== '0x';
  const nestedError = record.error;
  const jsonRpcErrorCode = getNestedJsonRpcError(error).code;
  return !!nestedError && !hasRevertData && jsonRpcErrorCode !== 3;
}
