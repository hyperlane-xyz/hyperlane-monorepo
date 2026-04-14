import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { z } from 'zod';

const DEFAULT_PREDICATE_API_URL = 'https://api.predicate.io/v2/attestation';

export interface PredicateAttestation {
  uuid: string;
  expiration: number;
  attester: string;
  signature: string;
}

export interface PredicateAttestationResponse {
  policy_id: string;
  policy_name: string;
  verification_hash: string;
  is_compliant: boolean;
  attestation: PredicateAttestation;
}

export interface PredicateAttestationRequest {
  to: string;
  from: string;
  data: string;
  msg_value: string;
  chain: string;
}

const PredicateAttestationSchema = z.object({
  uuid: z.string(),
  expiration: z.number(),
  attester: z.string(),
  signature: z.string(),
});

const PredicateAttestationResponseSchema = z.object({
  policy_id: z.string(),
  policy_name: z.string(),
  verification_hash: z.string(),
  is_compliant: z.boolean(),
  attestation: PredicateAttestationSchema,
});

export class PredicateApiClient {
  private readonly logger = rootLogger.child({ module: 'PredicateApiClient' });
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl: string = DEFAULT_PREDICATE_API_URL) {
    assert(apiKey, 'Predicate API key is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async fetchAttestation(
    request: PredicateAttestationRequest,
  ): Promise<PredicateAttestationResponse> {
    this.logger.debug('Fetching attestation', {
      url: this.baseUrl,
      request,
    });

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Predicate API error (${response.status}): ${errorText}`);
    }

    const result = PredicateAttestationResponseSchema.parse(
      await response.json(),
    );

    if (!result.is_compliant) {
      throw new Error(
        `Transaction not compliant: policy=${result.policy_id}, hash=${result.verification_hash}`,
      );
    }

    this.logger.debug('Attestation received', {
      uuid: result.attestation.uuid,
    });
    return result;
  }
}
