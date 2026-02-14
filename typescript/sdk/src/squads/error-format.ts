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

export interface StringifyUnknownSquadsErrorOptions {
  preferErrorMessageForErrorInstances?: boolean;
  preferErrorStackForErrorInstances?: boolean;
  formatObject?: (value: object) => string | undefined;
  placeholder?: string;
}

export function stringifyUnknownSquadsError(
  error: unknown,
  options: StringifyUnknownSquadsErrorOptions = {},
): string {
  const placeholder = options.placeholder ?? '[unstringifiable error]';
  const preferErrorMessageForErrorInstances =
    options.preferErrorMessageForErrorInstances === true;
  const preferErrorStackForErrorInstances =
    options.preferErrorStackForErrorInstances === true;
  const formatObject = options.formatObject;

  if (error instanceof Error) {
    if (preferErrorStackForErrorInstances) {
      try {
        if (typeof error.stack === 'string') {
          const normalizedStack = normalizeStringifiedSquadsError(error.stack);
          if (normalizedStack) {
            return normalizedStack;
          }
        }
      } catch {}
    }

    if (preferErrorMessageForErrorInstances) {
      try {
        const normalizedMessage = normalizeStringifiedSquadsError(error.message);
        if (normalizedMessage) {
          return normalizedMessage;
        }
      } catch {}
    }

    try {
      const normalizedError = normalizeStringifiedSquadsError(String(error));
      return normalizedError ?? placeholder;
    } catch {
      return placeholder;
    }
  }

  if (typeof error === 'string') {
    const normalizedError = normalizeStringifiedSquadsError(error);
    return normalizedError ?? placeholder;
  }

  if (error && typeof error === 'object') {
    try {
      const stack = (error as { stack?: unknown }).stack;
      if (typeof stack === 'string') {
        const normalizedStack = normalizeStringifiedSquadsError(stack);
        if (normalizedStack) {
          return normalizedStack;
        }
      }
    } catch {}

    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        const normalizedMessage = normalizeStringifiedSquadsError(message);
        if (normalizedMessage) {
          return normalizedMessage;
        }
      }
    } catch {}

    if (typeof formatObject === 'function') {
      try {
        const formattedObject = formatObject(error);
        if (typeof formattedObject === 'string') {
          const normalizedFormattedObject =
            normalizeStringifiedSquadsError(formattedObject);
          if (normalizedFormattedObject) {
            return normalizedFormattedObject;
          }
        }
      } catch {}
    }
  }

  try {
    const normalizedError = normalizeStringifiedSquadsError(String(error));
    return normalizedError ?? placeholder;
  } catch {
    return placeholder;
  }
}
