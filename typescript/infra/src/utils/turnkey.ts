import {
  MultiProvider,
  TurnkeyClientManager,
  TurnkeyConfig,
  TurnkeyConfigSchema,
  TurnkeyEvmSigner,
  TurnkeySealevelSigner,
} from '@hyperlane-xyz/sdk';
import {
  SignerBackendError,
  type Eip712Payload,
  type SignerAccount,
  type TransactionSignerBackend,
} from '@hyperlane-xyz/http-registry-server';
import {
  TurnkeyActivityConsensusNeededError,
  TurnkeyActivityError,
  TurnkeyRequestError,
} from '@turnkey/http';
import { ethers } from 'ethers';

import {
  ProtocolType,
  ensure0x,
  eqAddress,
  fromHexString,
  isEVMLike,
  isValidTransactionHashEvm,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/deploy-environment.js';
import { TurnkeyRole, type TurnkeySignerProtocol } from '../roles.js';

import { fetchLatestGCPSecret } from './gcloud.js';

export type TurnkeySigner = TurnkeySealevelSigner | TurnkeyEvmSigner;

/**
 * Get the GCP secret name for a Turnkey role
 */
export const turnkeySecret = (
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
) => `${deployEnvironment}-turnkey-${role}`;

export async function getTurnkeyConfig(
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
): Promise<TurnkeyConfig> {
  const secretName = turnkeySecret(deployEnvironment, role);
  const secretData = await fetchLatestGCPSecret(secretName);
  return TurnkeyConfigSchema.parse(JSON.parse(secretData));
}

function getTurnkeyKeyMetadata(protocol: TurnkeySignerProtocol) {
  switch (protocol) {
    case ProtocolType.Ethereum:
      return {
        curve: 'CURVE_SECP256K1' as const,
        addressFormat: 'ADDRESS_FORMAT_ETHEREUM' as const,
        outputCurve: 'secp256k1' as const,
      };
    case ProtocolType.Sealevel:
      return {
        curve: 'CURVE_ED25519' as const,
        addressFormat: 'ADDRESS_FORMAT_SOLANA' as const,
        outputCurve: 'ed25519' as const,
      };
    default: {
      const _exhaustive: never = protocol;
      throw new Error(`Unsupported Turnkey signer protocol: ${_exhaustive}`);
    }
  }
}

function getTurnkeyTransactionType(protocol: TurnkeySignerProtocol) {
  switch (protocol) {
    case ProtocolType.Ethereum:
      return 'TRANSACTION_TYPE_ETHEREUM' as const;
    case ProtocolType.Sealevel:
      return 'TRANSACTION_TYPE_SOLANA' as const;
    default: {
      const _exhaustive: never = protocol;
      throw new Error(`Unsupported Turnkey signer protocol: ${_exhaustive}`);
    }
  }
}

/** Native transaction backend used only by the local HTTP registry signer. */
export class TurnkeyTransactionSignerBackend implements TransactionSignerBackend {
  private readonly manager: TurnkeyClientManager;
  private account?: SignerAccount;

  constructor(
    private readonly config: TurnkeyConfig,
    private readonly protocol: TurnkeySignerProtocol,
  ) {
    this.manager = new TurnkeyClientManager(config);
  }

  async healthCheck(): Promise<void> {
    const healthy = await this.manager.healthCheck();
    if (!healthy) throw new Error('Turnkey health check failed');
    await this.getAccount();
  }

  async getAccount(): Promise<SignerAccount> {
    if (this.account) return this.account;

    const { privateKey } = await this.manager.getClient().getPrivateKey({
      privateKeyId: this.config.privateKeyId,
    });
    const expected = getTurnkeyKeyMetadata(this.protocol);
    if (privateKey.privateKeyId !== this.config.privateKeyId) {
      throw new Error('Turnkey returned a different private key');
    }
    if (privateKey.curve !== expected.curve) {
      throw new Error(`Turnkey key has incompatible curve ${privateKey.curve}`);
    }
    const address = privateKey.addresses.find(
      ({ format }) => format === expected.addressFormat,
    )?.address;
    if (!address) {
      throw new Error(`Turnkey key is missing ${expected.addressFormat}`);
    }
    if (!eqAddress(address, this.config.publicKey)) {
      throw new Error('Configured publicKey does not match Turnkey key');
    }
    this.account = {
      address:
        this.protocol === ProtocolType.Ethereum
          ? ethers.utils.getAddress(address)
          : address,
      curve: expected.outputCurve,
    };
    return this.account;
  }

  async signTransaction(
    protocol: ProtocolType,
    unsignedTransaction: Uint8Array,
  ): Promise<{ signedTransaction: Uint8Array; backendRequestId?: string }> {
    if (protocol !== this.protocol) {
      throw new Error(
        `Backend is configured for ${this.protocol}, not ${protocol}`,
      );
    }
    try {
      const { activity, signedTransaction } = await this.manager
        .getClient()
        .signTransaction({
          signWith: this.config.privateKeyId,
          type: getTurnkeyTransactionType(this.protocol),
          unsignedTransaction: Buffer.from(unsignedTransaction).toString('hex'),
        });
      assertTurnkeyActivityCompleted(activity);
      const result =
        signedTransaction ??
        activity.result?.signTransactionResult?.signedTransaction;
      if (!result) {
        throw new SignerBackendError(
          'unavailable',
          'Turnkey signing activity returned no transaction',
          activity.id,
        );
      }
      return {
        signedTransaction: fromHexString(result),
        backendRequestId: activity.id,
      };
    } catch (error) {
      throw mapTurnkeyBackendError(error);
    }
  }

  async signTypedData(
    typedData: Eip712Payload,
  ): Promise<{ signature: string; backendRequestId?: string }> {
    if (this.protocol !== ProtocolType.Ethereum) {
      throw new Error('Typed-data signing requires an Ethereum backend');
    }
    try {
      const { activity, r, s, v } = await this.manager
        .getClient()
        .signRawPayload({
          signWith: this.config.privateKeyId,
          payload: JSON.stringify(typedData),
          encoding: 'PAYLOAD_ENCODING_EIP712',
          hashFunction: 'HASH_FUNCTION_NO_OP',
        });
      assertTurnkeyActivityCompleted(activity);
      if (!r || !s || !v) {
        throw new SignerBackendError(
          'unavailable',
          'Turnkey typed-data activity returned no signature',
          activity.id,
        );
      }
      return {
        signature: ethers.utils.joinSignature({
          r: normalizeSignatureComponent('r', r),
          s: normalizeSignatureComponent('s', s),
          v: normalizeRecoveryV(v),
        }),
        backendRequestId: activity.id,
      };
    } catch (error) {
      throw mapTurnkeyBackendError(error);
    }
  }
}

function assertTurnkeyActivityCompleted(activity: {
  id: string;
  status: string;
}): void {
  switch (activity.status) {
    case 'ACTIVITY_STATUS_COMPLETED':
      return;
    case 'ACTIVITY_STATUS_CONSENSUS_NEEDED':
      throw new SignerBackendError(
        'approvalRequired',
        'Turnkey activity requires approval',
        activity.id,
      );
    case 'ACTIVITY_STATUS_REJECTED':
      throw new SignerBackendError(
        'denied',
        'Turnkey rejected the signing activity',
        activity.id,
      );
    default:
      throw new SignerBackendError(
        'unavailable',
        `Turnkey signing activity has status ${activity.status}`,
        activity.id,
      );
  }
}

function normalizeSignatureComponent(label: string, value: string): string {
  const normalized = ensure0x(value);
  if (!isValidTransactionHashEvm(normalized)) {
    throw new SignerBackendError(
      'unavailable',
      `Turnkey returned an invalid ${label}`,
    );
  }
  return normalized;
}

function normalizeRecoveryV(value: string): number {
  const parsed = Number.parseInt(value, 16);
  if (parsed === 0 || parsed === 1) return parsed + 27;
  if (parsed === 27 || parsed === 28) return parsed;
  throw new SignerBackendError(
    'unavailable',
    'Turnkey returned an invalid recovery id',
  );
}

function mapTurnkeyBackendError(error: unknown): Error {
  if (error instanceof SignerBackendError) return error;
  if (error instanceof TurnkeyActivityConsensusNeededError) {
    return new SignerBackendError(
      'approvalRequired',
      'Turnkey activity requires approval',
      error.activityId,
    );
  }
  if (error instanceof TurnkeyActivityError) {
    return new SignerBackendError(
      'denied',
      'Turnkey denied the signing activity',
      error.activityId,
    );
  }
  if (error instanceof TurnkeyRequestError) {
    return new SignerBackendError('unavailable', 'Turnkey is unavailable');
  }
  return error instanceof Error ? error : new Error('Unknown Turnkey error');
}

/**
 * Generic helper to create and health-check a Turnkey signer from GCP Secret Manager
 */
export async function createTurnkeySigner(
  deployEnvironment: DeployEnvironment,
  role: TurnkeyRole,
): Promise<TurnkeySigner> {
  const secretName = turnkeySecret(deployEnvironment, role);
  try {
    const turnkeyConfig = await getTurnkeyConfig(deployEnvironment, role);

    // Create the appropriate signer based on role
    let signer: TurnkeySigner;
    switch (role) {
      case TurnkeyRole.SealevelDeployer:
        signer = new TurnkeySealevelSigner(turnkeyConfig);
        break;
      case TurnkeyRole.EvmDeployer:
      case TurnkeyRole.EvmLegacyDeployer:
      case TurnkeyRole.EvmLegacyRebalancer:
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
