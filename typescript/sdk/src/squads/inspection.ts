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

export function inspectPropertyValue(
  value: unknown,
  property: PropertyKey,
): {
  propertyValue: unknown;
  readError: unknown | undefined;
} {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return {
      propertyValue: undefined,
      readError: undefined,
    };
  }

  try {
    return {
      propertyValue: (value as Record<PropertyKey, unknown>)[property],
      readError: undefined,
    };
  } catch (error) {
    return {
      propertyValue: undefined,
      readError: error,
    };
  }
}

export function inspectPromiseLikeThenValue(value: unknown): {
  thenValue: unknown;
  readError: unknown | undefined;
} {
  const { propertyValue, readError } = inspectPropertyValue(value, 'then');
  return {
    thenValue: propertyValue,
    readError,
  };
}

export function inspectInstanceOf(
  value: unknown,
  constructor: abstract new (...args: never[]) => unknown,
): {
  matches: boolean;
  readFailed: boolean;
} {
  try {
    return {
      matches: value instanceof constructor,
      readFailed: false,
    };
  } catch {
    return {
      matches: false,
      readFailed: true,
    };
  }
}
