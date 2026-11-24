import SafeApiKit, { type SafeApiKitConfig } from '@safe-global/api-kit';
import Safe, { SafeProviderConfig } from '@safe-global/protocol-kit';
import {
  getMultiSendCallOnlyDeployment,
  getMultiSendDeployment,
} from '@safe-global/safe-deployments';

import {
  Address,
  assert,
  eqAddressEvm,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName, ChainNameOrId } from '../types.js';

import { SafeQueueService } from './safeQueueService.js';

const SAFE_API_DOMAINS = ['safe.global', '5afe.dev'];
const SAFE_GATEWAY_HOSTS = ['api.safe.global', 'api.5afe.dev'];
const TRAILING_SLASHES_REGEX = /\/+$/;
const GATEWAY_TX_SERVICE_PATH_REGEX = /^\/tx-service\/[^/]+\/api$/;

export const SAFE_API_RETRIES = 10;
export const SAFE_API_BASE_RETRY_MS = 1000;

type SafeApiKitInstance = SafeApiKit.default;

type GetSafeOptions = {
  allowUnresolvedSafeVersion?: boolean;
};

function isSafeApiKitConstructor(
  value: unknown,
): value is typeof SafeApiKit.default {
  return typeof value === 'function';
}

export function safeApiKeyRequired(txServiceUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(txServiceUrl);
    return (
      protocol === 'https:' &&
      SAFE_API_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
    );
  } catch {
    return false;
  }
}

export function normalizeSafeTxServiceUrl(txServiceUrl: string): string {
  const trimmedUrl = txServiceUrl.replace(TRAILING_SLASHES_REGEX, '');
  const normalizedUrl = trimmedUrl.endsWith('/api')
    ? trimmedUrl
    : `${trimmedUrl}/api`;
  const gateway = getSafeGatewayUrl(normalizedUrl);
  return gateway
    ? `https://${gateway.hostname}${gateway.pathname}`
    : normalizedUrl;
}

function getSafeGatewayUrl(txServiceUrl: string): URL | undefined {
  try {
    const url = new URL(txServiceUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      SAFE_GATEWAY_HOSTS.includes(url.hostname) &&
      GATEWAY_TX_SERVICE_PATH_REGEX.test(url.pathname)
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export function isSafeGlobalTxServiceUrl(txServiceUrl: string): boolean {
  return (
    getSafeGatewayUrl(normalizeSafeTxServiceUrl(txServiceUrl)) !== undefined
  );
}

export function getSafeApiKitConfig(
  chainId: number,
  txServiceUrl: string,
  gnosisSafeApiKey?: string,
): SafeApiKitConfig {
  const normalizedTxServiceUrl = normalizeSafeTxServiceUrl(txServiceUrl);
  const apiKey = safeApiKeyRequired(normalizedTxServiceUrl)
    ? gnosisSafeApiKey
    : undefined;
  const baseConfig = {
    chainId: BigInt(chainId),
    apiKey,
  };

  // Derive the production URL from chainId to preserve hosted authentication.
  // API Kit always derives a production URL, so staging needs its explicit URL.
  if (
    apiKey &&
    isSafeGlobalTxServiceUrl(normalizedTxServiceUrl) &&
    new URL(normalizedTxServiceUrl).origin === 'https://api.safe.global'
  ) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    txServiceUrl: normalizedTxServiceUrl,
  };
}

export function getSafeService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): SafeApiKitInstance {
  const { gnosisSafeTransactionServiceUrl, gnosisSafeApiKey } =
    multiProvider.getChainMetadata(chain);
  assert(
    gnosisSafeTransactionServiceUrl,
    `must provide tx service url for ${chain}`,
  );

  const chainId = multiProvider.getEvmChainId(chain);
  assert(chainId, `Chain is not an EVM chain: ${chain}`);

  const config = getSafeApiKitConfig(
    chainId,
    gnosisSafeTransactionServiceUrl,
    gnosisSafeApiKey,
  );
  assert(
    isSafeApiKitConstructor(SafeApiKit),
    '@safe-global/api-kit default export is not a constructor',
  );
  try {
    return new SafeApiKit(config);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === `Network with chainId ${chainId} not found` ||
        error.message.includes(
          'There is no transaction service available for chainId',
        )) &&
      !config.txServiceUrl &&
      isSafeGlobalTxServiceUrl(gnosisSafeTransactionServiceUrl)
    ) {
      return new SafeApiKit({
        ...config,
        txServiceUrl: normalizeSafeTxServiceUrl(
          gnosisSafeTransactionServiceUrl,
        ),
      });
    }
    throw error;
  }
}

export function getSafeQueueService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): SafeQueueService | undefined {
  const { gnosisSafeTransactionServiceUrl, gnosisSafeApiKey } =
    multiProvider.getChainMetadata(chain);
  if (
    !gnosisSafeTransactionServiceUrl ||
    !isSafeGlobalTxServiceUrl(gnosisSafeTransactionServiceUrl)
  ) {
    return undefined;
  }

  const gateway = new URL(gnosisSafeTransactionServiceUrl);
  return new SafeQueueService(
    `https://${gateway.hostname}`,
    multiProvider.getEvmChainId(chain),
    gnosisSafeApiKey,
  );
}

// This is the version of the Safe contracts that the SDK is compatible with.
// Copied the MVP fields from https://github.com/safe-global/safe-core-sdk/blob/4d1c0e14630f951c2498e1d4dd521403af91d6e1/packages/protocol-kit/src/contracts/config.ts#L19
// because the SDK doesn't expose this value.
const safeDeploymentsVersions: Record<
  string,
  { multiSendVersion: string; multiSendCallOnlyVersion: string }
> = {
  '1.4.1': {
    multiSendVersion: '1.4.1',
    multiSendCallOnlyVersion: '1.4.1',
  },
  '1.3.0': {
    multiSendVersion: '1.3.0',
    multiSendCallOnlyVersion: '1.3.0',
  },
  '1.2.0': {
    multiSendVersion: '1.1.1',
    multiSendCallOnlyVersion: '1.3.0',
  },
  '1.1.1': {
    multiSendVersion: '1.1.1',
    multiSendCallOnlyVersion: '1.3.0',
  },
  '1.0.0': {
    multiSendVersion: '1.1.1',
    multiSendCallOnlyVersion: '1.3.0',
  },
};

// Override for chains that haven't yet been published in the safe-deployments package.
// Temporary until PR to safe-deployments package is merged and SDK dependency is updated.
const chainOverrides: Record<
  string,
  { multiSend: string; multiSendCallOnly: string }
> = {
  // berachain
  80094: {
    multiSend: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
  // igra
  38833: {
    multiSend: '0x218543288004CD07832472D464648173c77D7eB7',
    multiSendCallOnly: '0xA83c336B20401Af773B6219BA5027174338D1836',
  },
};

export async function getSafe(
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: Address,
  signer?: SafeProviderConfig['signer'],
  options: GetSafeOptions = {},
): Promise<Safe.default> {
  // Get the chain id for the given chain
  const chainId = `${multiProvider.getEvmChainId(chain)}`;

  // Get the safe version from the transaction service if one is available.
  // Fall back gracefully when the service is missing/unreachable so the Safe
  // instance can still be built for read-only/offline use (e.g. generating a
  // Safe Transaction Builder batch for chains without a usable tx service).
  let safeVersion: string | undefined;
  try {
    const safeService = getSafeService(chain, multiProvider);
    const { version: rawSafeVersion } = await retryAsync(
      () => safeService.getSafeInfo(safeAddress),
      SAFE_API_RETRIES,
      SAFE_API_BASE_RETRY_MS,
    );
    // Remove any build metadata from the version e.g. 1.3.0+L2 --> 1.3.0
    safeVersion = rawSafeVersion.split(' ')[0].split('+')[0].split('-')[0];
  } catch (error) {
    if (!options.allowUnresolvedSafeVersion) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    rootLogger.warn(
      `Could not fetch Safe version for ${chain} (transaction service unavailable); falling back to default multiSend resolution: ${errorMessage}`,
    );
  }

  // Get the multiSend and multiSendCallOnly deployments for the given chain
  let multiSend, multiSendCallOnly;
  if (chainOverrides[chainId]) {
    multiSend = {
      networkAddresses: { [chainId]: chainOverrides[chainId].multiSend },
    };
    multiSendCallOnly = {
      networkAddresses: {
        [chainId]: chainOverrides[chainId].multiSendCallOnly,
      },
    };
  } else if (safeVersion && safeDeploymentsVersions[safeVersion]) {
    const { multiSendVersion, multiSendCallOnlyVersion } =
      safeDeploymentsVersions[safeVersion];
    multiSend = getMultiSendDeployment({
      version: multiSendVersion,
      network: chainId,
    });
    multiSendCallOnly = getMultiSendCallOnlyDeployment({
      version: multiSendCallOnlyVersion,
      network: chainId,
    });
  }

  // @ts-ignore
  return Safe.init({
    provider: multiProvider.getChainMetadata(chain).rpcUrls[0].http,
    signer,
    safeAddress,
    contractNetworks: {
      [chainId]: {
        // Use the safe address for multiSendAddress and multiSendCallOnlyAddress
        // if the contract is not deployed or if the version is not found.
        multiSendAddress: multiSend?.networkAddresses[chainId] || safeAddress,
        multiSendCallOnlyAddress:
          multiSendCallOnly?.networkAddresses[chainId] || safeAddress,
      },
    },
  });
}

export async function getSafeDelegates(
  service: SafeApiKitInstance,
  safeAddress: Address,
): Promise<string[]> {
  const delegateResponse = await retryAsync(
    () => service.getSafeDelegates({ safeAddress }),
    SAFE_API_RETRIES,
    SAFE_API_BASE_RETRY_MS,
  );
  return delegateResponse.results.map((r) => r.delegate);
}

export async function canProposeSafeTransactions(
  proposer: Address,
  chain: ChainName,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<boolean> {
  let safeService: SafeApiKitInstance;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (e: unknown) {
    rootLogger.error('Failed to get Safe service for chain', {
      chain,
      chainName: multiProvider.tryGetChainName(chain),
      knownChains: multiProvider.getKnownChainNames(),
      error: e,
    });
    return false;
  }
  const safe = await getSafe(chain, multiProvider, safeAddress);
  const owners = await safe.getOwners();
  if (owners.some((owner) => eqAddressEvm(owner, proposer))) return true;

  const queue = getSafeQueueService(chain, multiProvider);
  if (queue) {
    return retryAsync(
      () => queue.isDelegate(proposer, safeAddress, owners),
      SAFE_API_RETRIES,
      SAFE_API_BASE_RETRY_MS,
    );
  }

  const delegates = await getSafeDelegates(safeService, safeAddress);
  return delegates.some((delegate) => eqAddressEvm(delegate, proposer));
}
