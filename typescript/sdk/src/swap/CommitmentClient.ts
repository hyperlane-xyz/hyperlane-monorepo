import {
  commitmentFromIcaCalls,
  encodeIcaCalls,
  normalizeCalls,
} from '../middleware/account/InterchainAccount.js';

import { CommitmentParams } from './types.js';

export class CommitmentClient {
  constructor(private readonly serviceUrl: string) {}

  async postCommitment(
    params: CommitmentParams,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const calls = normalizeCalls(params.calls);
      const commitment = commitmentFromIcaCalls(calls, params.salt);
      const encodedCalls = encodeIcaCalls(calls, params.salt);

      const resp = await fetch(this.serviceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calls: params.calls,
          encodedCalls,
          salt: params.salt,
          commitment,
          originDomain: params.originDomain,
          destinationDomain: params.destinationDomain,
          owner: params.owner,
          ismOverride: params.ismOverride,
        }),
      });

      if (!resp.ok) {
        return {
          success: false,
          error: `Failed to post commitment: ${resp.status} ${await resp.text()}`,
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  buildCommitmentHash(
    calls: Array<{ to: string; data: string; value: string }>,
    salt: string,
  ): string {
    return commitmentFromIcaCalls(normalizeCalls(calls), salt);
  }
}
