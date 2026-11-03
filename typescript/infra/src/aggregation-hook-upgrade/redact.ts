export const REDACTED_URL = '<redacted-url>';
export const REDACTED_HOST = '<redacted-host>';

// ethers embeds the RPC url and the resolved hostname in provider error
// messages (e.g. `url="https://host/<api key>"`, `"hostname":"host"`), and the
// multiProvider is built from secret RPC urls.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]}]+/gi;
const JSON_HOSTNAME_PATTERN = /("hostname"\s*:\s*")[^"]*"/gi;
const ASSIGNED_HOSTNAME_PATTERN = /(\bhostname=)[^\s,)}]+/gi;

export function redactSecrets(text: string): string {
  return text
    .replace(URL_PATTERN, REDACTED_URL)
    .replace(JSON_HOSTNAME_PATTERN, `$1${REDACTED_HOST}"`)
    .replace(ASSIGNED_HOSTNAME_PATTERN, `$1${REDACTED_HOST}`);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return redactSecrets(error.message);
  }
  return redactSecrets(String(error));
}
