import {
  MultiProvider,
  TurnkeyConfig,
  TurnkeyViemSigner,
  TurnkeySealevelSigner,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/environment.js';
import { TurnkeyRole } from '../roles.js';

import { fetchLatestGCPSecret } from './gcloud.js';

export type TurnkeySigner = TurnkeySealevelSigner | TurnkeyViemSigner;

function parseTurnkeyConfig(secretData: string): TurnkeyConfig {
  const parsed = JSON.parse(secretData);
  assert(
    typeof parsed === 'object' && parsed !== null,
    'Turnkey config must be an object',
  );
  assert(
    typeof parsed.organizationId === 'string',
    'Missing Turnkey organizationId',
  );
  assert(
    typeof parsed.apiPublicKey === 'string',
    'Missing Turnkey apiPublicKey',
  );
  assert(
    typeof parsed.apiPrivateKey === 'string',
    'Missing Turnkey apiPrivateKey',
  );
  assert(
    typeof parsed.privateKeyId === 'string',
    'Missing Turnkey privateKeyId',
  );
  assert(typeof parsed.publicKey === 'string', 'Missing Turnkey publicKey');
  assert(
    parsed.apiBaseUrl === undefined || typeof parsed.apiBaseUrl === 'string',
    'Turnkey apiBaseUrl must be a string',
  );
  return parsed;
}

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
    const turnkeyConfig = parseTurnkeyConfig(secretData);

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
        signer = new TurnkeyViemSigner(turnkeyConfig);
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

// TurnkeySealevelSigner is now imported from SDK

export async function getTurnkeySealevelDeployerSigner(
  deployEnvironment: DeployEnvironment,
): Promise<TurnkeySealevelSigner> {
  const signer = await createTurnkeySigner(
    deployEnvironment,
    TurnkeyRole.SealevelDeployer,
  );
  assert(
    signer instanceof TurnkeySealevelSigner,
    'Expected TurnkeySealevelSigner',
  );
  return signer;
}

// TurnkeyViemSigner is now imported from SDK

/**
 * Get Turnkey EVM signer for a specific role
 * Fetches the Turnkey config from GCP Secret Manager and creates a signer
 */
export async function getTurnkeyViemSigner(
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
): Promise<TurnkeyViemSigner> {
  const signer = await createTurnkeySigner(deployEnvironment, role);
  assert(signer instanceof TurnkeyViemSigner, 'Expected TurnkeyViemSigner');
  return signer;
}

export async function setTurnkeySignerForEvmChains(
  multiProvider: MultiProvider,
  deployEnvironment: DeployEnvironment,
  role: Exclude<TurnkeyRole, TurnkeyRole.SealevelDeployer>,
): Promise<void> {
  const turnkeySigner = await getTurnkeyViemSigner(deployEnvironment, role);
  await Promise.all(
    multiProvider.getKnownChainNames().reduce<Promise<void>[]>((acc, chain) => {
      if (multiProvider.getProtocol(chain) === ProtocolType.Ethereum) {
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
