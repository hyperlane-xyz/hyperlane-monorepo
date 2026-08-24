interface ErrorWithContext {
  context?: { logs?: unknown };
}

function isErrorWithContext(error: unknown): error is Error & ErrorWithContext {
  return error instanceof Error && 'context' in error;
}

/**
 * Formats an error for display, including the cause chain and any Solana
 * program logs attached to preflight failure errors.
 */
export function formatError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [error.message];

  if (
    isErrorWithContext(error) &&
    Array.isArray(error.context?.logs) &&
    error.context.logs.length > 0
  ) {
    parts.push(`Logs:\n  ${error.context.logs.join('\n  ')}`);
  }

  if (error.cause != null && depth < 10) {
    parts.push(`Caused by: ${formatError(error.cause, depth + 1)}`);
  }

  return parts.join('\n');
}
