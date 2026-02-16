const ARRAY_IS_ARRAY = Array.isArray;
const OBJECT_ENTRIES = Object.entries;
const OBJECT_KEYS = Object.keys;
const BUFFER_IS_BUFFER = Buffer.isBuffer;

export function inspectArrayValue(value: unknown): {
  isArray: boolean;
  readFailed: boolean;
} {
  try {
    return {
      isArray: ARRAY_IS_ARRAY(value),
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
      entries: OBJECT_ENTRIES(value as Record<string, unknown>),
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
      keys: OBJECT_KEYS(value as Record<string, unknown>),
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
      isBuffer: BUFFER_IS_BUFFER(value),
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
