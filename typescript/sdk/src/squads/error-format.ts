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

export function isGenericObjectStringifiedValue(value: string): boolean {
  return GENERIC_OBJECT_STRING_PATTERN.test(value.trim());
}

export function normalizeStringifiedSquadsError(
  formattedError: string,
): string | undefined {
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

export interface StringifyUnknownSquadsErrorOptions {
  preferErrorMessageForErrorInstances?: boolean;
  preferErrorStackForErrorInstances?: boolean;
  formatObject?: (value: object) => string | undefined;
  placeholder?: string;
}

export const DEFAULT_SQUADS_ERROR_PLACEHOLDER = '[unstringifiable error]';

export function stringifyUnknownSquadsError(
  error: unknown,
  options: StringifyUnknownSquadsErrorOptions = {},
): string {
  const placeholder = options.placeholder ?? DEFAULT_SQUADS_ERROR_PLACEHOLDER;
  const preferErrorMessageForErrorInstances =
    options.preferErrorMessageForErrorInstances === true;
  const preferErrorStackForErrorInstances =
    options.preferErrorStackForErrorInstances === true;
  const formatObject = options.formatObject;
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

  if (error instanceof Error) {
    if (preferErrorStackForErrorInstances) {
      const normalizedStack = readNormalizedCandidate(() => error.stack);
      if (normalizedStack) {
        return normalizedStack;
      }
    }

    if (preferErrorMessageForErrorInstances) {
      const normalizedMessage = readNormalizedCandidate(() => error.message);
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
