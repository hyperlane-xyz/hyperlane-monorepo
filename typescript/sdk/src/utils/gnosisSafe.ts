import SafeApiKit, {
  SafeMultisigTransactionListResponse,
} from '@safe-global/api-kit';
import Safe, {
  SafeAccountConfig,
  SafeProviderConfig,
} from '@safe-global/protocol-kit';
import type {
  MetaTransactionData,
  OperationType,
  SafeTransaction,
} from '@safe-global/safe-core-sdk-types';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendCallOnlyDeployment,
  getMultiSendDeployments,
  getMultiSendDeployment,
} from '@safe-global/safe-deployments';
import chalk from 'chalk';
import { BigNumber, ethers } from 'ethers';
import { formatUnits } from 'ethers/lib/utils.js';
import { Hex, decodeFunctionData, getAddress, isHex, parseAbi } from 'viem';

import {
  Address,
  assert,
  eqAddress,
  rootLogger,
  sleep,
} from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

const MIN_SAFE_API_VERSION = '5.18.0';

const SAFE_API_MAX_RETRIES = 10;
const SAFE_API_MIN_DELAY_MS = 1000;
const SAFE_API_MAX_DELAY_MS = 3000;
const URL_SCHEME_PREFIX_REGEX = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

const SAFE_INTERFACE = new ethers.utils.Interface([
  'function approveHash(bytes32 hashToApprove)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
  'function execTransactionFromModule(address to,uint256 value,bytes data,uint8 operation)',
  'function execTransactionFromModuleReturnData(address to,uint256 value,bytes data,uint8 operation) returns (bool success, bytes returnData)',
  'function addOwnerWithThreshold(address owner,uint256 _threshold)',
  'function removeOwner(address prevOwner,address owner,uint256 _threshold)',
  'function swapOwner(address prevOwner,address oldOwner,address newOwner)',
  'function changeThreshold(uint256 _threshold)',
  'function enableModule(address module)',
  'function disableModule(address prevModule,address module)',
  'function setGuard(address guard)',
  'function setFallbackHandler(address handler)',
  'function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)',
  'function simulateAndRevert(address targetContract,bytes calldataPayload)',
]);

function parseSemverPrefix(version: string): [number, number, number] {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid Safe API version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hasExplicitUrlScheme(value: string): boolean {
  return URL_SCHEME_PREFIX_REGEX.test(value);
}

export type SafeCallData = {
  to: Address;
  data: string;
  value?: string | number | bigint | { toString(): string };
};

export type SafeDeploymentConfig = {
  owners: Address[];
  threshold: number;
};

export type SafeDeploymentTransaction = {
  to: Address;
  data: string;
  value: string;
};

export type SafeOwnerUpdateCall = {
  to: Address;
  data: string;
  value: BigNumber;
  description: string;
};

export type SafeStatus = {
  chain: string;
  nonce: number;
  submissionDate: string;
  shortTxHash: string;
  fullTxHash: string;
  confs: number;
  threshold: number;
  status: string;
  balance: string;
};

export type SafeServiceTransaction = {
  to?: Address | null;
  data?: string | null;
  value?: string | null;
  proposer?: Address | null;
  safeTxHash?: string;
  [key: string]: unknown;
};

export type SafeServiceTransactionWithPayload = SafeServiceTransaction & {
  to: Address;
  data: string;
  value: string;
};

export type SafeAndService = {
  safeSdk: Safe.default;
  safeService: SafeApiKit.default;
};

type SignTypedDataMethod = ethers.Wallet['_signTypedData'];
type Eip712Signer = ethers.Signer & {
  _signTypedData: SignTypedDataMethod;
};

function assertEip712Signer(
  signer: ethers.Signer,
): asserts signer is Eip712Signer {
  assert(
    typeof (signer as { _signTypedData?: unknown })._signTypedData ===
      'function',
    'Signer must support _signTypedData for Safe transaction deletion',
  );
}

type SafeServicePendingTransactionsResponse = {
  results: Array<{
    safeTxHash: string;
  }>;
};

type SafeSignerProvider = Pick<MultiProvider, 'getSigner'>;

export enum SafeTxStatus {
  NO_CONFIRMATIONS = '🔴',
  PENDING = '🟡',
  ONE_AWAY = '🔵',
  READY_TO_EXECUTE = '🟢',
}

export function safeApiKeyRequired(txServiceUrl: string): boolean {
  const hostMatchesDomain = (host: string, domain: string): boolean => {
    const normalizedHost = host.replace(/\.+$/, '');
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  };

  const parseHostname = (value: string): string | undefined => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return undefined;
      }
      return parsed.hostname ? parsed.hostname.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  };

  const extractHostname = (value: string): string | undefined => {
    return (
      parseHostname(value) ??
      (!hasExplicitUrlScheme(value)
        ? parseHostname(`https://${value}`)
        : undefined)
    );
  };

  const hostname = extractHostname(txServiceUrl.trim());
  return (
    (hostname !== undefined && hostMatchesDomain(hostname, 'safe.global')) ||
    (hostname !== undefined && hostMatchesDomain(hostname, '5afe.dev'))
  );
}

export function hasSafeServiceTransactionPayload(
  transaction: SafeServiceTransaction | undefined,
): transaction is SafeServiceTransactionWithPayload {
  return (
    typeof transaction?.to === 'string' &&
    ethers.utils.isAddress(transaction.to) &&
    transaction.to.length > 0 &&
    typeof transaction.data === 'string' &&
    ethers.utils.isHexString(transaction.data) &&
    transaction.data.length > 0 &&
    typeof transaction.value === 'string' &&
    /^\d+$/.test(transaction.value) &&
    transaction.value.length > 0
  );
}

export function normalizeSafeServiceUrl(txServiceUrl: string): string {
  const parseUrl = (value: string): URL | undefined => {
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) {
        return undefined;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  };

  const canonicalizePath = (path: string): string => {
    let normalized = path.replace(/\/+$/, '');

    // Normalize existing /api suffix regardless of case.
    normalized = normalized.replace(/\/api$/i, '/api');

    // Some metadata may already point to a versioned API path (e.g. /api/v2).
    // Canonicalize this to /api so downstream helpers can append /v2/... safely.
    normalized = normalized.replace(/\/api\/v\d+$/i, '/api');

    if (normalized.endsWith('/api')) {
      return normalized;
    }
    return `${normalized}/api`;
  };

  const trimmedUrl = txServiceUrl.trim();
  const parsed =
    parseUrl(trimmedUrl) ??
    (!hasExplicitUrlScheme(trimmedUrl)
      ? parseUrl(`https://${trimmedUrl}`)
      : undefined);
  if (parsed) {
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = canonicalizePath(parsed.pathname);
    return parsed.toString();
  }
  // Fall back to string normalization for non-URL inputs.
  return canonicalizePath(trimmedUrl);
}

function getSafeTxServiceUrl(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): string {
  const { gnosisSafeTransactionServiceUrl } =
    multiProvider.getChainMetadata(chain);
  if (!gnosisSafeTransactionServiceUrl) {
    throw new Error(`must provide tx service url for ${chain}`);
  }
  return normalizeSafeServiceUrl(gnosisSafeTransactionServiceUrl);
}

function getSafeServiceHeaders(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): Record<string, string> {
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const { gnosisSafeApiKey } = multiProvider.getChainMetadata(chain);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'node-fetch',
  };
  if (gnosisSafeApiKey && safeApiKeyRequired(txServiceUrl)) {
    headers.Authorization = `Bearer ${gnosisSafeApiKey}`;
  }
  return headers;
}

export function getSafeService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): SafeApiKit.default {
  const { gnosisSafeApiKey } = multiProvider.getChainMetadata(chain);
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);

  const chainId = multiProvider.getEvmChainId(chain);
  if (!chainId) {
    throw new Error(`Chain is not an EVM chain: ${chain}`);
  }

  // @ts-ignore
  return new SafeApiKit({
    chainId: BigInt(chainId),
    txServiceUrl,
    // Only provide apiKey if the url contains safe.global or 5afe.dev
    apiKey: safeApiKeyRequired(txServiceUrl) ? gnosisSafeApiKey : undefined,
  });
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
  // zeronetwork
  543210: {
    multiSend: '0x0dFcccB95225ffB03c6FBB2559B530C2B7C8A912',
    multiSendCallOnly: '0xf220D3b4DFb23C4ade8C88E526C1353AbAcbC38F',
  },
  // berachain
  80094: {
    multiSend: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  },
};

export const DEFAULT_SAFE_DEPLOYMENT_VERSIONS = ['1.3.0', '1.4.1'] as const;

export function getKnownMultiSendAddresses(
  versions: string[] = [...DEFAULT_SAFE_DEPLOYMENT_VERSIONS],
): {
  multiSend: Address[];
  multiSendCallOnly: Address[];
} {
  const multiSend: Address[] = [];
  const multiSendCallOnly: Address[] = [];

  for (const version of versions) {
    const multiSendCallOnlyDeployments = getMultiSendCallOnlyDeployments({
      version,
    });
    const multiSendDeployments = getMultiSendDeployments({
      version,
    });
    if (!multiSendCallOnlyDeployments || !multiSendDeployments) {
      throw new Error(
        `MultiSend and MultiSendCallOnly deployments not found for version ${version}`,
      );
    }

    Object.values(multiSendCallOnlyDeployments.deployments).forEach(
      (deployment) => multiSendCallOnly.push(deployment.address as Address),
    );
    Object.values(multiSendDeployments.deployments).forEach((deployment) =>
      multiSend.push(deployment.address as Address),
    );
  }

  return {
    multiSend: [...new Set(multiSend)],
    multiSendCallOnly: [...new Set(multiSendCallOnly)],
  };
}

export async function getSafe(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  signer?: SafeProviderConfig['signer'],
): Promise<Safe.default> {
  // Get the chain id for the given chain
  const chainId = `${multiProvider.getEvmChainId(chain)}`;

  // Get the safe version
  const safeService = getSafeService(chain, multiProvider);

  const { version: rawSafeVersion } =
    await safeService.getSafeInfo(safeAddress);
  // Remove any build metadata from the version e.g. 1.3.0+L2 --> 1.3.0
  const safeVersion = rawSafeVersion.split(' ')[0].split('+')[0].split('-')[0];

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
  } else if (safeDeploymentsVersions[safeVersion]) {
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

export async function createSafeDeploymentTransaction(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  config: SafeDeploymentConfig,
): Promise<{
  safeAddress: Address;
  transaction: SafeDeploymentTransaction;
}> {
  const safeAccountConfig: SafeAccountConfig = {
    owners: config.owners,
    threshold: config.threshold,
  };

  // @ts-ignore
  const safe = await Safe.init({
    provider: multiProvider.getChainMetadata(chain).rpcUrls[0].http,
    predictedSafe: {
      safeAccountConfig,
    },
  });

  const { to, data, value } = await safe.createSafeDeploymentTransaction();
  assert(to, `Safe deployment tx for ${chain} has no to address`);
  assert(data, `Safe deployment tx for ${chain} has no calldata`);
  assert(
    value !== undefined && value !== null,
    'Safe deployment tx has no value',
  );
  const safeAddress = await safe.getAddress();

  return {
    safeAddress,
    transaction: {
      to,
      data,
      value: value.toString(),
    },
  };
}

export async function getSafeDelegates(
  service: SafeApiKit.default,
  safeAddress: Address,
): Promise<string[]> {
  const delegateResponse = await service.getSafeDelegates({ safeAddress });
  return delegateResponse.results.map((r) => r.delegate);
}

export async function canProposeSafeTransactions(
  proposer: Address,
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<boolean> {
  let safeService: SafeApiKit.default;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch {
    return false;
  }
  const safe = await getSafe(chain, multiProvider, safeAddress);
  const delegates = await getSafeDelegates(safeService, safeAddress);
  const owners = await safe.getOwners();
  return delegates.includes(proposer) || owners.includes(proposer);
}

/**
 * Retry helper for Safe API calls with random delay between 1-3 seconds.
 * Handles rate limiting errors with jittered backoff.
 */
export async function retrySafeApi<T>(runner: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SAFE_API_MAX_RETRIES; attempt++) {
    try {
      return await runner();
    } catch (error) {
      if (attempt === SAFE_API_MAX_RETRIES) {
        throw error;
      }

      const delayMs =
        Math.floor(
          Math.random() * (SAFE_API_MAX_DELAY_MS - SAFE_API_MIN_DELAY_MS),
        ) + SAFE_API_MIN_DELAY_MS;

      const warningMessage = chalk.yellow(
        `Safe API call failed (attempt ${attempt}/${SAFE_API_MAX_RETRIES}), retrying in ${delayMs}ms: ${error}`,
      );
      if (attempt > SAFE_API_MAX_RETRIES - 3) {
        rootLogger.warn(warningMessage);
      } else {
        rootLogger.debug(warningMessage);
      }

      await sleep(delayMs);
    }
  }
  throw new Error('Unreachable');
}

export async function isLegacySafeApi(version?: string): Promise<boolean> {
  if (!version) {
    throw new Error('Version is required');
  }
  const minVersion = parseSemverPrefix(MIN_SAFE_API_VERSION);
  const versionParts = parseSemverPrefix(version);
  for (let i = 0; i < minVersion.length; ++i) {
    const v = versionParts[i];
    if (v < minVersion[i]) return true;
    if (v > minVersion[i]) return false;
  }
  return false;
}

export async function resolveSafeSigner(
  chain: ChainNameOrId,
  signerProvider: SafeSignerProvider,
  signer?: SafeProviderConfig['signer'],
): Promise<NonNullable<SafeProviderConfig['signer']>> {
  if (signer) {
    return signer;
  }

  const multiProviderSigner = signerProvider.getSigner(
    chain,
  ) as ethers.Signer & {
    privateKey?: string;
  };
  if (multiProviderSigner.privateKey) {
    return multiProviderSigner.privateKey;
  }

  const signerAddress = await multiProviderSigner.getAddress();
  rootLogger.debug(
    `MultiProvider signer ${signerAddress} on ${chain} does not expose a private key. ` +
      'Falling back to address-based signer configuration for protocol-kit.',
  );
  return signerAddress;
}

export async function getSafeAndService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  signer?: SafeProviderConfig['signer'],
): Promise<SafeAndService> {
  let safeService: SafeApiKit.default;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (error) {
    throw new Error(
      `Failed to initialize Safe service for chain ${chain}: ${error}`,
    );
  }

  const { version } = await retrySafeApi(() => safeService.getServiceInfo());
  const isLegacy = await isLegacySafeApi(version);
  if (isLegacy) {
    throw new Error(
      `The Safe Transaction Service API for chain "${chain}" is running an outdated (legacy) version. ` +
        `Please contact the API owner to upgrade to at least version ${MIN_SAFE_API_VERSION} or newer. ` +
        `This application requires Safe Transaction Service version ${MIN_SAFE_API_VERSION} or higher to function correctly.`,
    );
  }

  const safeSigner = await resolveSafeSigner(chain, multiProvider, signer);
  let safeSdk: Safe.default;
  try {
    safeSdk = await retrySafeApi(() =>
      getSafe(chain, multiProvider, safeAddress, safeSigner),
    );
  } catch (error) {
    throw new Error(`Failed to initialize Safe for chain ${chain}: ${error}`);
  }
  return { safeSdk, safeService };
}

export function createSafeTransactionData(
  call: SafeCallData,
): MetaTransactionData {
  return {
    to: call.to,
    data: call.data.toString(),
    value: call.value?.toString() || '0',
  };
}

export async function createSafeTransaction(
  safeSdk: Safe.default,
  transactions: MetaTransactionData[],
  onlyCalls?: boolean,
  nonce?: number,
): Promise<SafeTransaction> {
  return safeSdk.createTransaction({
    transactions,
    onlyCalls,
    ...(nonce !== undefined ? { options: { nonce: Number(nonce) } } : {}),
  });
}

export async function proposeSafeTransaction(
  chain: ChainNameOrId,
  safeSdk: Safe.default,
  safeService: SafeApiKit.default,
  safeTransaction: SafeTransaction,
  safeAddress: Address,
  signer: ethers.Signer,
): Promise<void> {
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
  const senderSignature = await safeSdk.signTypedData(safeTransaction);
  const senderAddress = await signer.getAddress();

  await retrySafeApi(() =>
    safeService.proposeTransaction({
      safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature: senderSignature.data,
    }),
  );

  rootLogger.info(
    chalk.green(`Proposed transaction on ${chain} with hash ${safeTxHash}`),
  );
}

export async function executeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: string,
): Promise<void> {
  const { safeSdk, safeService } = await getSafeAndService(
    chain,
    multiProvider,
    safeAddress,
  );
  const safeTransaction = await retrySafeApi(() =>
    safeService.getTransaction(safeTxHash),
  );
  if (!safeTransaction) {
    throw new Error(`Failed to fetch transaction details for ${safeTxHash}`);
  }

  let estimate;
  try {
    estimate = await retrySafeApi(() =>
      safeService.estimateSafeTransaction(safeAddress, safeTransaction),
    );
  } catch (error) {
    throw new Error(
      `Failed to estimate gas for Safe transaction ${safeTxHash} on chain ${chain}: ${error}`,
    );
  }
  const balance = await multiProvider
    .getProvider(chain)
    .getBalance(safeAddress);
  if (balance.lt(estimate.safeTxGas)) {
    throw new Error(
      `Safe ${safeAddress} on ${chain} has insufficient balance (${balance.toString()}) for estimated gas (${
        estimate.safeTxGas
      })`,
    );
  }

  await safeSdk.executeTransaction(safeTransaction);
  rootLogger.info(
    chalk.green.bold(`Executed transaction ${safeTxHash} on ${chain}`),
  );
}

export async function getSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeTxHash: string,
): Promise<SafeServiceTransaction | undefined> {
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const headers = getSafeServiceHeaders(chain, multiProvider);
  const txDetailsUrl = `${txServiceUrl}/v2/multisig-transactions/${safeTxHash}/`;

  try {
    return await retrySafeApi(async () => {
      const txDetailsResponse = await fetch(txDetailsUrl, {
        method: 'GET',
        headers,
      });
      if (!txDetailsResponse.ok) {
        throw new Error(`HTTP error! status: ${txDetailsResponse.status}`);
      }
      return (await txDetailsResponse.json()) as SafeServiceTransaction;
    });
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to fetch transaction details for ${safeTxHash} after ${SAFE_API_MAX_RETRIES} attempts: ${error}`,
      ),
    );
    return;
  }
}

export async function deleteSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: string,
): Promise<void> {
  const signer = multiProvider.getSigner(chain);
  const chainId = multiProvider.getEvmChainId(chain);
  if (!chainId) {
    throw new Error(`Chain is not an EVM chain: ${chain}`);
  }
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const headers = getSafeServiceHeaders(chain, multiProvider);

  const txDetailsUrl = `${txServiceUrl}/v2/multisig-transactions/${safeTxHash}/`;
  const txDetailsResponse = await fetch(txDetailsUrl, {
    method: 'GET',
    headers,
  });

  if (!txDetailsResponse.ok) {
    rootLogger.error(
      chalk.red(`Failed to fetch transaction details for ${safeTxHash}`),
    );
    return;
  }

  const txDetails = (await txDetailsResponse.json()) as SafeServiceTransaction;
  const proposer = txDetails.proposer;
  if (!proposer) {
    rootLogger.error(
      chalk.red(`No proposer found for transaction ${safeTxHash}`),
    );
    return;
  }

  const signerAddress = await signer.getAddress();
  if (!eqAddress(proposer, signerAddress)) {
    rootLogger.info(
      chalk.italic(
        `Skipping deletion of transaction ${safeTxHash} proposed by ${proposer}`,
      ),
    );
    return;
  }
  rootLogger.info(`Deleting transaction ${safeTxHash} proposed by ${proposer}`);

  try {
    assertEip712Signer(signer);
    const totp = Math.floor(Date.now() / 1000 / 3600);
    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        DeleteRequest: [
          { name: 'safeTxHash', type: 'bytes32' },
          { name: 'totp', type: 'uint256' },
        ],
      },
      domain: {
        name: 'Safe Transaction Service',
        version: '1.0',
        chainId,
        verifyingContract: safeAddress,
      },
      primaryType: 'DeleteRequest',
      message: {
        safeTxHash,
        totp,
      },
    };

    const signature = await signer._signTypedData(
      typedData.domain,
      { DeleteRequest: typedData.types.DeleteRequest },
      typedData.message,
    );

    const deleteUrl = `${txServiceUrl}/v2/multisig-transactions/${safeTxHash}/`;
    const res = await fetch(deleteUrl, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ safeTxHash, signature }),
    });

    if (res.status === 204) {
      rootLogger.info(
        chalk.green(
          `Successfully deleted transaction ${safeTxHash} on ${chain}`,
        ),
      );
      return;
    }

    const errorBody = await res.text();
    rootLogger.error(
      chalk.red(
        `Failed to delete transaction ${safeTxHash} on ${chain}: Status ${res.status} ${res.statusText}. Response body: ${errorBody}`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(`Failed to delete transaction ${safeTxHash} on ${chain}:`),
      error,
    );
  }
}

export async function deleteAllPendingSafeTxs(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<void> {
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const headers = getSafeServiceHeaders(chain, multiProvider);
  const pendingTxsUrl = `${txServiceUrl}/v2/safes/${safeAddress}/multisig-transactions/?executed=false&limit=100`;
  const pendingTxsResponse = await fetch(pendingTxsUrl, {
    method: 'GET',
    headers,
  });

  if (!pendingTxsResponse.ok) {
    rootLogger.error(
      chalk.red(`Failed to fetch pending transactions for ${safeAddress}`),
    );
    return;
  }

  const pendingTxs =
    (await pendingTxsResponse.json()) as SafeServicePendingTransactionsResponse;
  for (const tx of pendingTxs.results) {
    await deleteSafeTx(chain, multiProvider, safeAddress, tx.safeTxHash);
  }

  rootLogger.info(
    `Deleted all pending transactions on ${chain} for ${safeAddress}\n`,
  );
}

export async function getOwnerChanges(
  currentOwners: Address[],
  expectedOwners: Address[],
): Promise<{
  ownersToRemove: Address[];
  ownersToAdd: Address[];
}> {
  const ownersToRemove = currentOwners.filter(
    (owner) => !expectedOwners.some((newOwner) => eqAddress(owner, newOwner)),
  );
  const ownersToAdd = expectedOwners.filter(
    (newOwner) => !currentOwners.some((owner) => eqAddress(newOwner, owner)),
  );

  return { ownersToRemove, ownersToAdd };
}

/**
 * Sentinel value used in Safe's owner linked list.
 * From OwnerManager.sol: address internal constant SENTINEL_OWNERS = address(0x1).
 */
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001';

function findPrevOwner(owners: Address[], targetOwner: Address): Address {
  const targetIndex = owners.findIndex((owner) =>
    eqAddress(owner, targetOwner),
  );
  if (targetIndex === -1) {
    throw new Error(`Owner ${targetOwner} not found in owners list`);
  }

  if (targetIndex === 0) {
    return SENTINEL_OWNERS;
  }
  return owners[targetIndex - 1];
}

async function createSwapOwnerTransactions(
  safeSdk: Safe.default,
  currentOwners: Address[],
  ownersToRemove: Address[],
  ownersToAdd: Address[],
): Promise<SafeOwnerUpdateCall[]> {
  rootLogger.info(
    chalk.magentaBright(
      `Using swapOwner for ${ownersToRemove.length} owner replacement(s)`,
    ),
  );

  const ownerPositions = new Map<Address, number>();
  currentOwners.forEach((owner, index) => {
    ownerPositions.set(owner, index);
  });

  const sortedOwnersToRemove = [...ownersToRemove].sort(
    (a: Address, b: Address) =>
      (ownerPositions.get(a) ?? 0) - (ownerPositions.get(b) ?? 0),
  );

  const effectiveOwners = [...currentOwners];
  const transactions: SafeOwnerUpdateCall[] = [];
  const safeAddress = await safeSdk.getAddress();

  for (let i = 0; i < sortedOwnersToRemove.length; i++) {
    const oldOwner = sortedOwnersToRemove[i];
    const newOwner = ownersToAdd[i];
    const prevOwner = findPrevOwner(effectiveOwners, oldOwner);
    const oldOwnerIndex = effectiveOwners.findIndex((owner: Address) =>
      eqAddress(owner, oldOwner),
    );
    if (oldOwnerIndex !== -1) {
      effectiveOwners[oldOwnerIndex] = newOwner;
    }

    const data = SAFE_INTERFACE.encodeFunctionData('swapOwner', [
      prevOwner,
      oldOwner,
      newOwner,
    ]);

    transactions.push({
      to: safeAddress,
      data,
      value: BigNumber.from(0),
      description: `Swap safe owner ${oldOwner} with ${newOwner} (prevOwner: ${prevOwner})`,
    });
  }

  return transactions;
}

async function createThresholdTransaction(
  safeSdk: Safe.default,
  currentThreshold: number,
  newThreshold: number,
): Promise<SafeOwnerUpdateCall> {
  rootLogger.info(
    chalk.magentaBright(
      `Threshold change ${currentThreshold} => ${newThreshold}`,
    ),
  );
  const { data: thresholdTxData } =
    await safeSdk.createChangeThresholdTx(newThreshold);
  return {
    to: thresholdTxData.to,
    data: thresholdTxData.data,
    value: BigNumber.from(thresholdTxData.value),
    description: `Change safe threshold to ${newThreshold}`,
  };
}

export async function updateSafeOwner({
  safeSdk,
  owners,
  threshold,
}: {
  safeSdk: Safe.default;
  owners?: Address[];
  threshold?: number;
}): Promise<SafeOwnerUpdateCall[]> {
  const currentThreshold = await safeSdk.getThreshold();
  const newThreshold = threshold ?? currentThreshold;

  const currentOwners = await safeSdk.getOwners();
  const expectedOwners = owners ?? currentOwners;

  const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
    currentOwners,
    expectedOwners,
  );

  rootLogger.info(chalk.magentaBright('Owners to remove:', ownersToRemove));
  rootLogger.info(chalk.magentaBright('Owners to add:', ownersToAdd));

  if (ownersToRemove.length !== ownersToAdd.length) {
    throw new Error(
      `Owner changes must be 1-to-1 swaps. Found ${ownersToRemove.length} removals and ${ownersToAdd.length} additions.`,
    );
  }

  const transactions: SafeOwnerUpdateCall[] = [];
  if (ownersToRemove.length > 0) {
    const swapTxs = await createSwapOwnerTransactions(
      safeSdk,
      currentOwners,
      ownersToRemove,
      ownersToAdd,
    );
    transactions.push(...swapTxs);
  }

  if (currentThreshold !== newThreshold) {
    const thresholdTx = await createThresholdTransaction(
      safeSdk,
      currentThreshold,
      newThreshold,
    );
    transactions.push(thresholdTx);
  }

  return transactions;
}

export async function getPendingTxsForChains(
  chains: string[],
  multiProvider: MultiProvider,
  safes: Record<string, Address>,
): Promise<SafeStatus[]> {
  const txs: SafeStatus[] = [];
  await Promise.all(
    chains.map(async (chain) => {
      if (!safes[chain]) {
        rootLogger.error(chalk.red.bold(`No safe found for ${chain}`));
        return;
      }

      if (chain === 'endurance') {
        rootLogger.info(
          chalk.gray.italic(
            `Skipping chain ${chain} as it does not have a functional safe API`,
          ),
        );
        return;
      }

      let safeSdk: Safe.default;
      let safeService: SafeApiKit.default;
      try {
        ({ safeSdk, safeService } = await getSafeAndService(
          chain,
          multiProvider,
          safes[chain],
        ));
      } catch (error) {
        rootLogger.warn(
          chalk.yellow(
            `Skipping chain ${chain} as there was an error getting the safe service: ${error}`,
          ),
        );
        return;
      }

      const threshold = await safeSdk.getThreshold();

      let pendingTxs: SafeMultisigTransactionListResponse;
      rootLogger.info(
        chalk.gray.italic(
          `Fetching pending transactions for safe ${safes[chain]} on ${chain}`,
        ),
      );
      try {
        pendingTxs = await retrySafeApi(() =>
          safeService.getPendingTransactions(safes[chain]),
        );
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to fetch pending transactions for safe ${safes[chain]} on ${chain} after ${SAFE_API_MAX_RETRIES} attempts: ${error}`,
          ),
        );
        return;
      }

      if (!pendingTxs || pendingTxs.results.length === 0) {
        rootLogger.info(
          chalk.gray.italic(
            `No pending transactions found for safe ${safes[chain]} on ${chain}`,
          ),
        );
        return;
      }

      const balance = await safeSdk.getBalance();
      const nativeToken = await multiProvider.getNativeToken(chain);
      const formattedBalance = formatUnits(balance, nativeToken.decimals);

      pendingTxs.results.forEach(
        ({ nonce, submissionDate, safeTxHash, confirmations }) => {
          const confs = confirmations?.length ?? 0;
          const status =
            confs >= threshold
              ? SafeTxStatus.READY_TO_EXECUTE
              : confs === 0
                ? SafeTxStatus.NO_CONFIRMATIONS
                : threshold - confs === 1
                  ? SafeTxStatus.ONE_AWAY
                  : SafeTxStatus.PENDING;

          txs.push({
            chain,
            nonce: Number(nonce),
            submissionDate: new Date(submissionDate).toDateString(),
            shortTxHash: `${safeTxHash.slice(0, 6)}...${safeTxHash.slice(-4)}`,
            fullTxHash: safeTxHash,
            confs,
            threshold,
            status,
            balance: `${Number(formattedBalance).toFixed(5)} ${
              nativeToken.symbol
            }`,
          });
        },
      );
    }),
  );
  return txs.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

export function parseSafeTx(tx: AnnotatedEV5Transaction) {
  return SAFE_INTERFACE.parseTransaction({
    data: tx.data ?? '0x',
    value: tx.value,
  });
}

export function asHex(hex?: string): Hex {
  return isHex(hex) ? (hex as Hex) : (`0x${hex}` as Hex);
}

export function decodeMultiSendData(
  encodedData: string,
): MetaTransactionData[] {
  const decodedData = decodeFunctionData({
    abi: parseAbi([
      'function multiSend(bytes memory transactions) public payable',
    ]),
    data: asHex(encodedData),
  });

  const args = decodedData.args;
  const txs: MetaTransactionData[] = [];
  let index = 2;

  if (args) {
    const [transactionBytes] = args;
    while (index < transactionBytes.length) {
      const operation = `0x${transactionBytes.slice(index, (index += 2))}`;
      const to = `0x${transactionBytes.slice(index, (index += 40))}`;
      const value = `0x${transactionBytes.slice(index, (index += 64))}`;
      const dataLength =
        parseInt(`${transactionBytes.slice(index, (index += 64))}`, 16) * 2;
      const data = `0x${transactionBytes.slice(index, (index += dataLength))}`;

      txs.push({
        operation: Number(operation) as OperationType,
        to: getAddress(to),
        value: BigInt(value).toString(),
        data,
      });
    }
  }

  return txs;
}
