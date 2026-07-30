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

// GCP service account IDs are capped at 30 characters. `<context>-<env>-<chain>`
// overflows that for many real chain names (chain names vary far more in length
// than context/environment do), so the chain component is a short deterministic
// hash rather than the literal name — still unique per (context, env, chain),
// just not human-readable from the ID alone (the account's display name carries
// the readable form instead).
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

// Provisions the GCP service account for a validator *release* (one per chain,
// matching ValidatorHelmManager — not one per validator index). A chain can have
// multiple validator indices (e.g. redundant ReleaseCandidate validators), all
// sharing one StatefulSet pod template and therefore one Kubernetes
// ServiceAccount — Workload Identity binds one KSA to one GSA, so this GSA has
// to be the single identity every replica in the release authenticates as,
// granted access to each index's own KMS key and bucket individually (see
// `grantAccessForIndex`, called once per index as #configForValidator builds
// each one) rather than one GSA per index.
//
// No static credential is created anywhere here — the GSA is only ever used
// via GKE Workload Identity (see `bindWorkloadIdentity`), never via an
// exported service account key.
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
    );
    this.serviceAccountEmail = email;
    return email;
  }

  // Grants this release's shared GSA access to one validator index's key and
  // bucket. Safe to call once per index — grants accumulate on the same GSA
  // rather than overwriting, so after every index in a chain has been
  // processed, the GSA can sign with and write to all of them.
  async grantAccessForIndex(key: AgentGcpKmsKey, bucketName: string) {
    const email = await this.requireServiceAccountEmail();
    await key.grantSignerRole(email);
    await grantServiceAccountStorageRoleIfNotExists(
      email,
      bucketName,
      'roles/storage.objectAdmin',
    );
  }

  // Lets a pod running as the given Kubernetes ServiceAccount (in the given
  // k8s namespace) impersonate this GSA — no key file, no secret, ever.
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
