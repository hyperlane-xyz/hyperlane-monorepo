import { DEFAULT_CCS_URL } from '../utils/constants.js';
import type { CallCommitmentBody } from './schemas.js';

export { DEFAULT_CCS_URL };

export class CCSError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CCSError';
  }
}

export async function postCallCommitment(
  ccsUrl: string,
  path: string,
  body: CallCommitmentBody,
): Promise<void> {
  const res = await fetch(`${ccsUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      // bigint strings are already strings in the schema
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new CCSError(
      `Call Commitment Service rejected (${res.status}): ${text}`,
      res.status,
    );
  }
}
