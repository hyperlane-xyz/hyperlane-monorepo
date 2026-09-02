const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    CANONICAL_BASE64.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}
