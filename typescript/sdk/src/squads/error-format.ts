const GENERIC_OBJECT_STRING_PATTERN = /^\[object .+\]$/;
const TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN = /\s*:\s*$/;
export const BUILTIN_SQUADS_ERROR_LABELS = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
] as const;

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
