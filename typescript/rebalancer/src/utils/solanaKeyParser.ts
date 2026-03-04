/**
 * Parses a Solana private key from various formats.
 * Supports JSON array format and comma-separated byte values.
 *
 * @param rawKey - Raw private key string in JSON array or comma-separated format
 * @returns Uint8Array representation of the private key
 * @throws Error if the key format is invalid
 */
export function parseSolanaPrivateKey(rawKey: string): Uint8Array {
  try {
    if (rawKey.trim().startsWith('[')) {
      const parsed = JSON.parse(rawKey);
      if (Array.isArray(parsed)) return Uint8Array.from(parsed);
    }
    const byComma = rawKey
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
    if (byComma.length > 0) return Uint8Array.from(byComma);
  } catch {
    // fall through to throw below
  }
  throw new Error(
    'Invalid HYP_INVENTORY_KEY_SOLANA format. Expected JSON byte array or comma-separated bytes.',
  );
}
