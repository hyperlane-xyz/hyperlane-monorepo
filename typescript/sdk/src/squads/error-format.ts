const GENERIC_OBJECT_STRING_PATTERN = /^\[object .+\]$/;
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
    .replace(/:$/, '')
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
