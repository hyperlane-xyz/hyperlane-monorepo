const GENERIC_OBJECT_STRING_PATTERN = /^\[object .+\]$/;
const TRAILING_COLON_WITH_OPTIONAL_SPACING_PATTERN = /\s*:\s*$/;
const GENERIC_ERROR_LABELS = new Set([
  'error',
  'typeerror',
  'rangeerror',
  'referenceerror',
  'syntaxerror',
  'urierror',
  'evalerror',
  'aggregateerror',
]);

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
