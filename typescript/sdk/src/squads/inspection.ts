export function inspectArrayValue(value: unknown): {
  isArray: boolean;
  readFailed: boolean;
} {
  try {
    return {
      isArray: Array.isArray(value),
      readFailed: false,
    };
  } catch {
    return {
      isArray: false,
      readFailed: true,
    };
  }
}

export function inspectPromiseLikeThenValue(value: unknown): {
  thenValue: unknown;
  readError: unknown | undefined;
} {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return {
      thenValue: undefined,
      readError: undefined,
    };
  }

  try {
    return {
      thenValue: (value as { then?: unknown }).then,
      readError: undefined,
    };
  } catch (error) {
    return {
      thenValue: undefined,
      readError: error,
    };
  }
}
