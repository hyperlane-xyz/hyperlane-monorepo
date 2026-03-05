import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const SOLANA_KEY_ERROR_MESSAGE =
  'Invalid Solana private key format. Expected JSON byte array, comma-separated bytes, or base58 key (32 or 64 bytes). Set HYP_INVENTORY_KEY_SEALEVEL env var.';

function throwInvalidSolanaKey(reason: string): never {
  throw new Error(`${SOLANA_KEY_ERROR_MESSAGE} ${reason}`);
}

function validateKeyLength(bytes: number[]): void {
  if (bytes.length !== 32 && bytes.length !== 64) {
    throwInvalidSolanaKey(
      `Received ${bytes.length} bytes; expected exactly 32 or 64.`,
    );
  }
}

function toSecretKey(bytes: number[]): Uint8Array {
  validateKeyLength(bytes);
  if (bytes.length === 32) {
    return Keypair.fromSeed(Uint8Array.from(bytes)).secretKey;
  }
  return Uint8Array.from(bytes);
}

/**
 * Parses a Solana private key from various formats.
 * Supports JSON array format, comma-separated byte values, and base58 values.
 *
 * @param rawKey - Raw private key string in JSON array, comma-separated, or base58 format
 * @returns Uint8Array representation of the private key
 * @throws Error if the key format is invalid
 */
export function parseSolanaPrivateKey(rawKey: string): Uint8Array {
  const trimmed = rawKey.trim();
  if (trimmed === '') {
    throwInvalidSolanaKey('Input is empty.');
  }

  try {
    if (trimmed.startsWith('[')) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throwInvalidSolanaKey('JSON input must be an array of bytes.');
      }

      const bytes = parsed.map((value, index) => {
        if (!Number.isInteger(value)) {
          throwInvalidSolanaKey(
            `JSON byte at index ${index} must be an integer.`,
          );
        }
        if (value < 0 || value > 255) {
          throwInvalidSolanaKey(
            `JSON byte at index ${index} must be in range 0..255.`,
          );
        }
        return value;
      });

      return toSecretKey(bytes);
    }

    if (trimmed.includes(',')) {
      const bytes = trimmed.split(',').map((segment, index) => {
        const segmentTrimmed = segment.trim();
        if (segmentTrimmed === '') {
          throwInvalidSolanaKey(
            `Comma-separated byte at index ${index} is empty.`,
          );
        }

        const value = Number(segmentTrimmed);
        if (!Number.isFinite(value)) {
          throwInvalidSolanaKey(
            `Comma-separated byte at index ${index} is not numeric.`,
          );
        }
        if (!Number.isInteger(value)) {
          throwInvalidSolanaKey(
            `Comma-separated byte at index ${index} must be an integer.`,
          );
        }
        if (value < 0 || value > 255) {
          throwInvalidSolanaKey(
            `Comma-separated byte at index ${index} must be in range 0..255.`,
          );
        }

        return value;
      });

      return toSecretKey(bytes);
    }

    try {
      const decoded = bs58.decode(trimmed);
      const bytes = Array.from(decoded);
      return toSecretKey(bytes);
    } catch {}
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(SOLANA_KEY_ERROR_MESSAGE)
    ) {
      throw error;
    }
    throwInvalidSolanaKey('Failed to parse key input.');
  }

  throwInvalidSolanaKey(
    'Failed to match supported format (JSON array, comma-separated bytes, or base58 key).',
  );
}
