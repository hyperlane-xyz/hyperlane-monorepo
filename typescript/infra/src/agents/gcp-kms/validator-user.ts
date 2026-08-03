import { createHash } from 'crypto';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts.js';
import type { DeployEnvironment } from '../../config/deploy-environment.js';
import {
  bindWorkloadIdentityUserIfNotExists,
  createServiceAccountIfNotExists,
  grantServiceAccountStorageRoleIfNotExists,
} from '../../utils/gcloud.js';

import { AgentGcpKmsKey } from './kms-key.js';

// GCP service account IDs are capped at 30 chars, which `<context>-<env>-<chain>`
// overflows for many chain names — hashed instead of truncated to stay unique.
function chainNameHash(chainName: ChainName): string {
  return createHash('sha256').update(chainName).digest('hex').slice(0, 8);
}

export function gcpValidatorServiceAccountName(
  context: Contexts,
  environment: DeployEnvironment,
  chainName: ChainName,
): string {
  return `${context}-${environment}-${chainNameHash(chainName)}`;
}

// GCP service account for a validator *release* (one per chain, matching
// ValidatorHelmManager) — not one per validator index. A chain's indices all
// share one StatefulSet pod template and therefore one KSA, and Workload
// Identity binds one KSA to one GSA, so this GSA is granted access to each
// index's key/bucket individually (see `grantAccessForIndex`) rather than
// each index getting its own GSA.
export class ValidatorAgentGcpUser {
  readonly serviceAccountName: string;
  private serviceAccountEmail: string | undefined;

  constructor(
    readonly environment: DeployEnvironment,
    readonly context: Contexts,
    readonly chainName: ChainName,
    private readonly project: string,
  ) {
    this.serviceAccountName = gcpValidatorServiceAccountName(
      context,
      environment,
      chainName,
    );
  }

  async createServiceAccountIfNotExists(): Promise<string> {
    const email = await createServiceAccountIfNotExists(
      this.serviceAccountName,
      this.project,
    );
    this.serviceAccountEmail = email;
    return email;
  }

  // Call once per index — grants accumulate on the shared GSA rather than
  // overwriting.
  async grantAccessForIndex(key: AgentGcpKmsKey, bucketName: string) {
    const email = await this.requireServiceAccountEmail();
    await key.grantSignerRole(email);
    await grantServiceAccountStorageRoleIfNotExists(
      email,
      bucketName,
      'roles/storage.objectAdmin',
    );
  }

  // No key file, no secret, ever — auth is the KSA identity itself.
  async bindWorkloadIdentity(namespace: string, ksaName: string) {
    const email = await this.requireServiceAccountEmail();
    await bindWorkloadIdentityUserIfNotExists(
      email,
      this.project,
      namespace,
      ksaName,
    );
  }

  private async requireServiceAccountEmail(): Promise<string> {
    if (!this.serviceAccountEmail) {
      await this.createServiceAccountIfNotExists();
    }
    if (!this.serviceAccountEmail) {
      throw new Error(
        `Failed to resolve service account email for ${this.serviceAccountName}`,
      );
    }
    return this.serviceAccountEmail;
  }
}
