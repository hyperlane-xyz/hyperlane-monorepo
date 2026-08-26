import { z } from 'zod';

import {
  MultiProvider,
  TurnkeyConfigSchema,
  TurnkeyEvmSigner,
  TurnkeySealevelSigner,
} from '@hyperlane-xyz/sdk';
import { assert, isEVMLike, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/deploy-environment.js';
import { TurnkeyRole } from '../roles.js';

import { fetchLatestGCPSecret } from './gcloud.js';

export type TurnkeySigner = TurnkeySealevelSigner | TurnkeyEvmSigner;

/**
 * Get the GCP secret name for a Turnkey role
 */
export const turnkeySecret = (
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
) => `${deployEnvironment}-turnkey-${role}`;

/**
 * Generic helper to create and health-check a Turnkey signer from GCP Secret Manager
 */
export async function createTurnkeySigner(
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
): Promise<TurnkeySigner> {
  const secretName = turnkeySecret(deployEnvironment, role);
  try {
    const secretData = await fetchLatestGCPSecret(secretName);
    const turnkeyConfig = TurnkeyConfigSchema.parse(JSON.parse(secretData));

    // Create the appropriate signer based on role
    let signer: TurnkeySigner;
    switch (role) {
      case TurnkeyRole.SealevelDeployer:
        signer = new TurnkeySealevelSigner(turnkeyConfig);
        break;
      case TurnkeyRole.EvmDeployer:
      case TurnkeyRole.EvmLegacyDeployer:
      case TurnkeyRole.EvmRebalancer:
      case TurnkeyRole.EvmIgpClaimer:
      case TurnkeyRole.EvmIgpUpdater:
      case TurnkeyRole.EvmWarpFeesOwner:
        signer = new TurnkeyEvmSigner(turnkeyConfig);
        break;
      default:
        throw new Error(`Unknown Turnkey role: ${role}`);
    }

    // Run health check
    const healthy = await signer.healthCheck();
    if (!healthy) {
      throw new Error('Turnkey health check failed after initialization');
    }

    return signer;
  } catch (error) {
    rootLogger.error(`Failed to initialize Turnkey ${role} signer:`, error);
    rootLogger.error(
      `Ensure the Turnkey config is stored in GCP Secret Manager:\n` +
        `  Secret name: ${secretName}\n` +
        `  Secret format: JSON with fields organizationId, apiPublicKey, apiPrivateKey, privateKeyId, publicKey`,
    );
    throw error;
  }
}

/**
 * A standalone Turnkey API-key secret (e.g. `haggis-turnkey-api-key`): only the
 * account credential, no wallet identity. Used to override which Turnkey user
 * authenticates a signer while keeping the base role's private key (wallet).
 */
const TurnkeyAccountKeySchema = z.object({
  publicKey: z.string(),
  privateKey: z.string(),
});

/**
 * Build a Turnkey EVM signer that signs with the given role's private key
 * (wallet) but authenticates as the Turnkey account stored in a separate
 * API-key secret. This lets a caller keep the default deployer wallet while
 * swapping the authenticating user, so a user-scoped Turnkey policy (consensus)
 * can auto-complete for that user instead of stalling on root consensus.
 */
export async function getTurnkeyEvmSignerWithAccountOverride(
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
  accountSecretName: string,
): Promise<TurnkeyEvmSigner> {
  const baseSecretName = turnkeySecret(deployEnvironment, role);
  const baseConfig = TurnkeyConfigSchema.parse(
    JSON.parse(await fetchLatestGCPSecret(baseSecretName)),
  );
  const account = TurnkeyAccountKeySchema.parse(
    JSON.parse(await fetchLatestGCPSecret(accountSecretName)),
  );

  const signer = new TurnkeyEvmSigner({
    ...baseConfig,
    apiPublicKey: account.publicKey,
    apiPrivateKey: account.privateKey,
  });
  assert(
    await signer.healthCheck(),
    `Turnkey health check failed for ${role} wallet authed as account ${accountSecretName}`,
  );
  return signer;
}

// TurnkeySealevelSigner is now imported from SDK

export async function getTurnkeySealevelDeployerSigner(
  deployEnvironment: DeployEnvironment,
): Promise<TurnkeySealevelSigner> {
  return createTurnkeySigner(
    deployEnvironment,
    TurnkeyRole.SealevelDeployer,
  ) as Promise<TurnkeySealevelSigner>;
}

// TurnkeyEvmSigner is now imported from SDK

/**
 * Get Turnkey EVM signer for a specific role
 * Fetches the Turnkey config from GCP Secret Manager and creates a signer
 */
export async function getTurnkeyEvmSigner(
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
): Promise<TurnkeyEvmSigner> {
  return createTurnkeySigner(
    deployEnvironment,
    role,
  ) as Promise<TurnkeyEvmSigner>;
}

export async function setTurnkeySignerForEvmChains(
  multiProvider: MultiProvider,
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
): Promise<void> {
  const turnkeySigner = await getTurnkeyEvmSigner(deployEnvironment, role);
  await Promise.all(
    multiProvider.getKnownChainNames().reduce<Promise<void>[]>((acc, chain) => {
      if (isEVMLike(multiProvider.getProtocol(chain))) {
        acc.push(
          (async () => {
            const provider = multiProvider.getProvider(chain);
            const signer = await turnkeySigner.getSigner(provider);
            multiProvider.setSigner(chain, signer);
          })(),
        );
      }
      return acc;
    }, []),
  );
}
