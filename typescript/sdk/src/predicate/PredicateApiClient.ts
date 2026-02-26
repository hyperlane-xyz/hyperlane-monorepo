import { rootLogger } from '@hyperlane-xyz/utils';

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

export class PredicateApiClient {
  private readonly logger = rootLogger.child({ module: 'PredicateApiClient' });
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl: string = DEFAULT_PREDICATE_API_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async fetchAttestation(
    request: PredicateAttestationRequest,
  ): Promise<PredicateAttestationResponse> {
    this.logger.debug('Fetching attestation', {
      to: request.to,
      chain: request.chain,
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

    const result: PredicateAttestationResponse = await response.json();

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
