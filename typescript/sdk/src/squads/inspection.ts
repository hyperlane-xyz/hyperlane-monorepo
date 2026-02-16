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

export function inspectObjectEntries(value: unknown): {
  entries: [string, unknown][];
  readError: unknown | undefined;
} {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return {
      entries: [],
      readError: undefined,
    };
  }

  try {
    return {
      entries: Object.entries(value as Record<string, unknown>),
      readError: undefined,
    };
  } catch (error) {
    return {
      entries: [],
      readError: error,
    };
  }
}

export function inspectObjectKeys(value: unknown): {
  keys: string[];
  readError: unknown | undefined;
} {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return {
      keys: [],
      readError: undefined,
    };
  }

  try {
    return {
      keys: Object.keys(value as Record<string, unknown>),
      readError: undefined,
    };
  } catch (error) {
    return {
      keys: [],
      readError: error,
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

export function inspectPropertyPresence(
  value: unknown,
  property: PropertyKey,
): {
  hasProperty: boolean;
  readError: unknown | undefined;
} {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return {
      hasProperty: false,
      readError: undefined,
    };
  }

  try {
    return {
      hasProperty: property in value,
      readError: undefined,
    };
  } catch (error) {
    return {
      hasProperty: false,
      readError: error,
    };
  }
}

export function inspectBufferValue(value: unknown): {
  isBuffer: boolean;
  readFailed: boolean;
} {
  try {
    return {
      isBuffer: Buffer.isBuffer(value),
      readFailed: false,
    };
  } catch {
    return {
      isBuffer: false,
      readFailed: true,
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
