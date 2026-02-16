const GENERIC_OBJECT_STRING_PATTERN = /^\[object .+\]$/;
const TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN = /\s*:\s*$/;
export const BUILTIN_SQUADS_ERROR_LABELS = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
] as const);

const GENERIC_ERROR_LABELS = new Set(
  BUILTIN_SQUADS_ERROR_LABELS.map((label) => label.toLowerCase()),
);

export function isGenericObjectStringifiedValue(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value
    .trim()
    .replace(TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN, '');
  return GENERIC_OBJECT_STRING_PATTERN.test(normalizedValue);
}

export function normalizeStringifiedSquadsError(
  formattedError: unknown,
): string | undefined {
  if (typeof formattedError !== 'string') {
    return undefined;
  }

  const trimmedFormattedError = formattedError.trim();
  const normalizedErrorLabel = trimmedFormattedError
    .replace(TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN, '')
    .toLowerCase();

  if (
    trimmedFormattedError.length === 0 ||
    isGenericObjectStringifiedValue(trimmedFormattedError) ||
    GENERIC_ERROR_LABELS.has(normalizedErrorLabel)
  ) {
    return undefined;
  }

  return formattedError;
}

function normalizeUnknownStringCandidate(value: unknown): string | undefined {
  return typeof value === 'string'
    ? normalizeStringifiedSquadsError(value)
    : undefined;
}

function inspectErrorInstance(value: unknown): {
  isError: boolean;
  readFailed: boolean;
} {
  try {
    return {
      isError: value instanceof Error,
      readFailed: false,
    };
  } catch {
    return {
      isError: false,
      readFailed: true,
    };
  }
}

export interface StringifyUnknownSquadsErrorOptions {
  preferErrorMessageForErrorInstances?: boolean;
  preferErrorStackForErrorInstances?: boolean;
  formatObject?: (value: object) => string | undefined;
  placeholder?: string;
}

export const DEFAULT_SQUADS_ERROR_PLACEHOLDER = '[unstringifiable error]';

export function stringifyUnknownSquadsError(
  error: unknown,
  options?: StringifyUnknownSquadsErrorOptions,
): string;
export function stringifyUnknownSquadsError(
  error: unknown,
  options?: unknown,
): string;
export function stringifyUnknownSquadsError(
  error: unknown,
  options: unknown = {},
): string {
  const optionsRecord =
    options && typeof options === 'object'
      ? (options as Record<string, unknown>)
      : undefined;
  const readOptionCandidate = (key: string): unknown => {
    if (!optionsRecord) {
      return undefined;
    }

    try {
      return optionsRecord[key];
    } catch {
      return undefined;
    }
  };

  const placeholderCandidate = readOptionCandidate('placeholder');
  const placeholder =
    typeof placeholderCandidate === 'string' &&
    placeholderCandidate.trim().length > 0
      ? placeholderCandidate
      : DEFAULT_SQUADS_ERROR_PLACEHOLDER;
  const preferErrorMessageForErrorInstances =
    readOptionCandidate('preferErrorMessageForErrorInstances') === true;
  const preferErrorStackForErrorInstances =
    readOptionCandidate('preferErrorStackForErrorInstances') === true;
  const formatObjectCandidate = readOptionCandidate('formatObject');
  const formatObject =
    typeof formatObjectCandidate === 'function'
      ? (formatObjectCandidate as (value: object) => string | undefined)
      : undefined;
  const stringifyErrorFallback = (value: unknown): string => {
    try {
      const normalizedError = normalizeStringifiedSquadsError(String(value));
      return normalizedError ?? placeholder;
    } catch {
      return placeholder;
    }
  };
  const readNormalizedCandidate = (
    readValue: () => unknown,
  ): string | undefined => {
    try {
      return normalizeUnknownStringCandidate(readValue());
    } catch {
      return undefined;
    }
  };

  const { isError, readFailed: errorInstanceReadFailed } =
    inspectErrorInstance(error);
  if (!errorInstanceReadFailed && isError) {
    const errorInstance = error as Error;
    if (preferErrorStackForErrorInstances) {
      const normalizedStack = readNormalizedCandidate(
        () => errorInstance.stack,
      );
      if (normalizedStack) {
        return normalizedStack;
      }
    }

    if (preferErrorMessageForErrorInstances) {
      const normalizedMessage = readNormalizedCandidate(
        () => errorInstance.message,
      );
      if (normalizedMessage) {
        return normalizedMessage;
      }
    }

    return stringifyErrorFallback(error);
  }

  if (typeof error === 'string') {
    const normalizedError = normalizeUnknownStringCandidate(error);
    return normalizedError ?? placeholder;
  }

  if (error && typeof error === 'object') {
    const normalizedStack = readNormalizedCandidate(
      () => (error as { stack?: unknown }).stack,
    );
    if (normalizedStack) {
      return normalizedStack;
    }

    const normalizedMessage = readNormalizedCandidate(
      () => (error as { message?: unknown }).message,
    );
    if (normalizedMessage) {
      return normalizedMessage;
    }

    if (typeof formatObject === 'function') {
      const normalizedFormattedObject = readNormalizedCandidate(() =>
        formatObject(error),
      );
      if (normalizedFormattedObject) {
        return normalizedFormattedObject;
      }
    }
  }

  return stringifyErrorFallback(error);
}
