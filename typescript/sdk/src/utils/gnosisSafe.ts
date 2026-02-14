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
// Strict semver parser for Safe tx-service versions:
// - accepts optional v/V prefix
// - accepts optional prerelease/build metadata identifiers
// - rejects malformed metadata (empty identifiers, invalid separators)
const SAFE_API_SEMVER_REGEX =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i;
const URL_SCHEME_WITH_AUTHORITY_REGEX = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const MALFORMED_HTTP_SCHEME_DELIMITER_REGEX = /^https?:(?!\/\/)/i;
const NON_AUTHORITY_URL_SCHEME_PREFIX_REGEX =
  /^(mailto|urn|data|blob|javascript):/i;
const GENERIC_URL_SCHEME_PREFIX_REGEX = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const HOST_WITH_PORT_PREFIX_REGEX = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const SCHEME_RELATIVE_HOST_WITH_EMPTY_PORT_REGEX = /^\/\/[^/?#:@]+:(?:[/?#]|$)/;
const USERINFO_LIKE_AUTHORITY_REGEX = /@|%(?:25)*40/i;
const RAW_BACKSLASH_REGEX = /\\/;
const FUNCTION_SELECTOR_HEX_LENGTH = 10;
const SAFE_TX_DATA_REQUIRED_ERROR = 'Safe transaction data is required';
const SAFE_TX_DATA_INVALID_HEX_ERROR = 'Safe transaction data must be hex';
const SAFE_TX_SELECTOR_REQUIRED_ERROR =
  'Safe transaction data must include function selector';
const SAFE_TX_PAYLOAD_INACCESSIBLE_ERROR =
  'Safe transaction payload fields are inaccessible';
const MULTISEND_SELECTOR_REQUIRED_ERROR =
  'Invalid multisend payload: missing multisend selector';
const SAFE_CALL_PAYLOAD_INACCESSIBLE_ERROR =
  'Safe call payload fields are inaccessible';
const SAFE_CREATED_TX_PAYLOAD_INACCESSIBLE_ERROR =
  'Safe SDK transaction payload fields are inaccessible';
const SAFE_TX_DATA_PAYLOAD_INACCESSIBLE_ERROR =
  'Safe transaction data payload fields are inaccessible';

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

function parseSemverPrefix(version: unknown): [number, number, number] {
  if (typeof version !== 'string') {
    throw new Error(
      `Invalid Safe API version: ${stringifyValueForError(version)}`,
    );
  }
  const match = version.trim().match(SAFE_API_SEMVER_REGEX);
  if (!match) {
    throw new Error(`Invalid Safe API version: ${version}`);
  }
  const [majorPart, minorPart, patchPart, prereleasePart] = [
    match[1],
    match[2],
    match[3],
    match[4],
  ];
  const hasInvalidLeadingZero = [majorPart, minorPart, patchPart].some(
    (part) => part.length > 1 && part.startsWith('0'),
  );
  if (hasInvalidLeadingZero) {
    throw new Error(`Invalid Safe API version: ${version}`);
  }
  if (prereleasePart) {
    const hasInvalidNumericPrereleaseIdentifier = prereleasePart
      .split('.')
      .some(
        (identifier) =>
          /^\d+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith('0'),
      );
    if (hasInvalidNumericPrereleaseIdentifier) {
      throw new Error(`Invalid Safe API version: ${version}`);
    }
  }
  const major = Number(majorPart);
  const minor = Number(minorPart);
  const patch = Number(patchPart);
  // Guard against precision loss when parsing extremely large numeric parts.
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    throw new Error(`Invalid Safe API version: ${version}`);
  }
  return [major, minor, patch];
}

function hasExplicitUrlScheme(value: string): boolean {
  if (HOST_WITH_PORT_PREFIX_REGEX.test(value)) {
    return false;
  }
  return (
    URL_SCHEME_WITH_AUTHORITY_REGEX.test(value) ||
    NON_AUTHORITY_URL_SCHEME_PREFIX_REGEX.test(value) ||
    GENERIC_URL_SCHEME_PREFIX_REGEX.test(value)
  );
}

function getUrlScheme(value: string): string | undefined {
  const schemeMatch = value.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  return schemeMatch?.[1]?.toLowerCase();
}

function isSchemeRelativeUrl(value: string): boolean {
  return /^\/\/[^/]/.test(value);
}

function isSlashPrefixedRelativePath(value: string): boolean {
  return value.startsWith('/') && !isSchemeRelativeUrl(value);
}

function hasSchemeRelativeHostWithEmptyPort(value: string): boolean {
  return SCHEME_RELATIVE_HOST_WITH_EMPTY_PORT_REGEX.test(value);
}

function extractHostlessAuthority(value: string): string | undefined {
  if (hasExplicitUrlScheme(value)) {
    return undefined;
  }

  const authorityAndPath = value.startsWith('//') ? value.slice(2) : value;
  return authorityAndPath.split(/[/?#]/, 1)[0];
}

function hasUserinfoLikeAuthority(value: string): boolean {
  const authority = extractHostlessAuthority(value);
  return (
    authority !== undefined && USERINFO_LIKE_AUTHORITY_REGEX.test(authority)
  );
}

function hasMalformedSchemeRelativeAuthority(value: string): boolean {
  // Treat scheme-relative authorities with missing host/userinfo as invalid
  // host-only values. Without this guard, URL fallback parsing can reinterpret
  // some malformed values (e.g. //:pass@safe.global) as valid safe hosts.
  return (
    value.startsWith('//@') ||
    value.startsWith('//:') ||
    (value.startsWith('//') && hasUserinfoLikeAuthority(value))
  );
}

function hasUserinfoLikeHostlessAuthority(value: string): boolean {
  return hasUserinfoLikeAuthority(value);
}

function hasPercentEncodedAuthority(value: string): boolean {
  const explicitAuthority = extractExplicitAuthority(value);
  if (explicitAuthority !== undefined && explicitAuthority.includes('%')) {
    return true;
  }

  const hostlessAuthority = extractHostlessAuthority(value);
  return hostlessAuthority !== undefined && hostlessAuthority.includes('%');
}

function hasNonAsciiAuthority(value: string): boolean {
  const explicitAuthority = extractExplicitAuthority(value);
  if (
    explicitAuthority !== undefined &&
    /[^\x00-\x7F]/.test(explicitAuthority)
  ) {
    return true;
  }

  const hostlessAuthority = extractHostlessAuthority(value);
  return (
    hostlessAuthority !== undefined && /[^\x00-\x7F]/.test(hostlessAuthority)
  );
}

function hasControlOrWhitespaceAuthority(value: string): boolean {
  const explicitAuthority = extractExplicitAuthority(value);
  if (
    explicitAuthority !== undefined &&
    /[\x00-\x20\x7F]/.test(explicitAuthority)
  ) {
    return true;
  }

  const hostlessAuthority = extractHostlessAuthority(value);
  return (
    hostlessAuthority !== undefined && /[\x00-\x20\x7F]/.test(hostlessAuthority)
  );
}

function hasInvalidSafeServiceUrlInput(value: string): boolean {
  return (
    hasRawBackslash(value) ||
    hasMalformedHttpSchemeDelimiter(value) ||
    hasExplicitUserinfoLikeAuthority(value) ||
    hasInvalidHostlessSafeServiceUrl(value) ||
    hasPercentEncodedAuthority(value) ||
    hasNonAsciiAuthority(value) ||
    hasControlOrWhitespaceAuthority(value)
  );
}

function hasInvalidHostlessSafeServiceUrl(value: string): boolean {
  return (
    isSlashPrefixedRelativePath(value) ||
    hasSchemeRelativeHostWithEmptyPort(value) ||
    hasMalformedSchemeRelativeAuthority(value) ||
    hasUserinfoLikeHostlessAuthority(value)
  );
}

function parseHttpUrl(value: string): URL | undefined {
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
}

function parseSchemeRelativeHttpUrl(value: string): URL | undefined {
  if (!isSchemeRelativeUrl(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value, 'https://safe-url-base.invalid');
    if (!parsed.hostname) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function extractExplicitAuthority(value: string): string | undefined {
  if (!URL_SCHEME_WITH_AUTHORITY_REGEX.test(value)) {
    return undefined;
  }

  const authorityAndPath = value.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/+/, '');
  return authorityAndPath.split(/[/?#]/, 1)[0];
}

function hasExplicitUserinfoLikeAuthority(value: string): boolean {
  const authority = extractExplicitAuthority(value);
  return (
    authority !== undefined && USERINFO_LIKE_AUTHORITY_REGEX.test(authority)
  );
}

function hasMalformedHttpSchemeDelimiter(value: string): boolean {
  return MALFORMED_HTTP_SCHEME_DELIMITER_REGEX.test(value);
}

function hasRawBackslash(value: string): boolean {
  return RAW_BACKSLASH_REGEX.test(value);
}

function hasUrlUserinfo(parsed: URL): boolean {
  return parsed.username.length > 0 || parsed.password.length > 0;
}

export type SafeCallData = {
  to: Address;
  data: string;
  value?: string | number | bigint | { toString(): string };
};

type ParseableSafeCallData = Omit<SafeCallData, 'to' | 'data' | 'value'> & {
  to?: unknown;
  data?: unknown;
  value?: unknown;
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
  let signTypedData: unknown;
  try {
    signTypedData = (signer as { _signTypedData?: unknown })._signTypedData;
  } catch {
    throw new Error(
      'Signer _signTypedData accessor is inaccessible for Safe transaction deletion',
    );
  }
  assert(
    typeof signTypedData === 'function',
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

export function safeApiKeyRequired(txServiceUrl: unknown): boolean {
  if (typeof txServiceUrl !== 'string') {
    return false;
  }
  const hostMatchesDomain = (host: string, domain: string): boolean => {
    const normalizedHost = host.replace(/\.+$/, '');
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  };

  const parseHostname = (value: string): string | undefined => {
    const parsed = parseHttpUrl(value);
    if (!parsed || hasUrlUserinfo(parsed)) {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  };

  const extractHostname = (value: string): string | undefined => {
    const hostname = parseHostname(value);
    if (hostname !== undefined) {
      return hostname;
    }

    const schemeRelativeParsed = parseSchemeRelativeHttpUrl(value);
    if (schemeRelativeParsed && !hasUrlUserinfo(schemeRelativeParsed)) {
      return schemeRelativeParsed.hostname.toLowerCase();
    }

    if (hasExplicitUrlScheme(value) || isSchemeRelativeUrl(value)) {
      return undefined;
    }

    return parseHostname(`https://${value}`);
  };

  const trimmedUrl = txServiceUrl.trim();
  if (hasInvalidSafeServiceUrlInput(trimmedUrl)) {
    return false;
  }

  const hostname = extractHostname(trimmedUrl);
  if (hostname === undefined) {
    return false;
  }
  return (
    hostMatchesDomain(hostname, 'safe.global') ||
    hostMatchesDomain(hostname, '5afe.dev')
  );
}

export function hasSafeServiceTransactionPayload(
  transaction: unknown,
): transaction is SafeServiceTransactionWithPayload {
  const payload =
    transaction !== null && typeof transaction === 'object'
      ? (transaction as SafeServiceTransaction)
      : undefined;
  try {
    return (
      typeof payload?.to === 'string' &&
      ethers.utils.isAddress(payload.to) &&
      payload.to.length > 0 &&
      typeof payload.data === 'string' &&
      ethers.utils.isHexString(payload.data) &&
      payload.data.length > 0 &&
      typeof payload.value === 'string' &&
      /^\d+$/.test(payload.value) &&
      payload.value.length > 0
    );
  } catch {
    return false;
  }
}

export function normalizeSafeServiceUrl(txServiceUrl: unknown): string {
  assert(
    typeof txServiceUrl === 'string',
    `Safe tx service URL must be a string: ${stringifyValueForError(txServiceUrl)}`,
  );
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
  assert(trimmedUrl.length > 0, 'Safe tx service URL is empty');
  if (hasInvalidSafeServiceUrlInput(trimmedUrl)) {
    throw new Error(`Safe tx service URL is invalid: ${trimmedUrl}`);
  }
  const hasScheme = hasExplicitUrlScheme(trimmedUrl);
  const parsed =
    parseHttpUrl(trimmedUrl) ??
    parseSchemeRelativeHttpUrl(trimmedUrl) ??
    (!hasScheme && !isSchemeRelativeUrl(trimmedUrl)
      ? parseHttpUrl(`https://${trimmedUrl}`)
      : undefined);
  if (!parsed && hasScheme) {
    const scheme = getUrlScheme(trimmedUrl);
    if (scheme === 'http' || scheme === 'https') {
      throw new Error(`Safe tx service URL is invalid: ${trimmedUrl}`);
    }
    throw new Error(`Safe tx service URL must use http(s): ${trimmedUrl}`);
  }
  if (!parsed) {
    throw new Error(`Safe tx service URL is invalid: ${trimmedUrl}`);
  }
  if (hasUrlUserinfo(parsed)) {
    throw new Error(`Safe tx service URL is invalid: ${trimmedUrl}`);
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = canonicalizePath(parsed.pathname);
  return parsed.toString();
}

function getSafeTxServiceUrl(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): string {
  const chainMetadata = getChainMetadataForSafe(chain, multiProvider);
  let rawTxServiceUrl: unknown;
  try {
    rawTxServiceUrl = (
      chainMetadata as { gnosisSafeTransactionServiceUrl?: unknown }
    ).gnosisSafeTransactionServiceUrl;
  } catch {
    throw new Error(`Safe tx service URL is inaccessible for ${chain}`);
  }
  assert(
    typeof rawTxServiceUrl === 'string' && rawTxServiceUrl.trim().length > 0,
    `Safe tx service URL must be provided for ${chain}: ${stringifyValueForError(rawTxServiceUrl)}`,
  );
  return normalizeSafeServiceUrl(rawTxServiceUrl);
}

function getSafeServiceHeaders(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): Record<string, string> {
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const chainMetadata = getChainMetadataForSafe(chain, multiProvider);
  let gnosisSafeApiKey: unknown;
  try {
    gnosisSafeApiKey = (chainMetadata as { gnosisSafeApiKey?: unknown })
      .gnosisSafeApiKey;
  } catch {
    throw new Error(`Safe API key is inaccessible for ${chain}`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'node-fetch',
  };
  if (
    typeof gnosisSafeApiKey === 'string' &&
    gnosisSafeApiKey.trim().length > 0 &&
    safeApiKeyRequired(txServiceUrl)
  ) {
    headers.Authorization = `Bearer ${gnosisSafeApiKey.trim()}`;
  }
  return headers;
}

export function getSafeService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): SafeApiKit.default {
  const chainMetadata = getChainMetadataForSafe(chain, multiProvider);
  let gnosisSafeApiKey: unknown;
  try {
    gnosisSafeApiKey = (chainMetadata as { gnosisSafeApiKey?: unknown })
      .gnosisSafeApiKey;
  } catch {
    throw new Error(`Safe API key is inaccessible for ${chain}`);
  }
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);

  let chainId: unknown;
  try {
    chainId = multiProvider.getEvmChainId(chain);
  } catch (error) {
    throw new Error(
      `Failed to resolve EVM chain id for ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    (typeof chainId === 'number' &&
      Number.isSafeInteger(chainId) &&
      chainId > 0) ||
      (typeof chainId === 'string' &&
        chainId.trim().length > 0 &&
        /^\d+$/.test(chainId.trim()) &&
        chainId.trim() !== '0') ||
      (typeof chainId === 'bigint' && chainId > 0n),
    `EVM chain id must be a positive integer for ${chain}: ${stringifyValueForError(chainId)}`,
  );
  const normalizedChainId = String(chainId).trim();
  let safeServiceChainId: bigint;
  try {
    safeServiceChainId = BigInt(normalizedChainId);
  } catch {
    throw new Error(
      `EVM chain id must be a positive integer for ${chain}: ${stringifyValueForError(chainId)}`,
    );
  }
  assert(
    safeServiceChainId > 0n,
    `EVM chain id must be a positive integer for ${chain}: ${stringifyValueForError(chainId)}`,
  );

  // @ts-ignore
  return new SafeApiKit({
    chainId: safeServiceChainId,
    txServiceUrl,
    // Only provide apiKey if the url contains safe.global or 5afe.dev
    apiKey:
      safeApiKeyRequired(txServiceUrl) && typeof gnosisSafeApiKey === 'string'
        ? gnosisSafeApiKey.trim()
        : undefined,
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
  versions: unknown = [...DEFAULT_SAFE_DEPLOYMENT_VERSIONS],
): {
  multiSend: Address[];
  multiSendCallOnly: Address[];
} {
  assert(
    Array.isArray(versions),
    `Safe deployment versions must be an array: ${stringifyValueForError(versions)}`,
  );
  const multiSend: Address[] = [];
  const multiSendCallOnly: Address[] = [];

  let versionsCount = 0;
  try {
    versionsCount = versions.length;
  } catch {
    throw new Error('Safe deployment versions list length is inaccessible');
  }
  assert(
    Number.isSafeInteger(versionsCount) && versionsCount >= 0,
    `Safe deployment versions list length is invalid: ${stringifyValueForError(versionsCount)}`,
  );

  for (let index = 0; index < versionsCount; index += 1) {
    let version: unknown;
    try {
      version = versions[index];
    } catch {
      throw new Error(
        `Safe deployment version entry is inaccessible at index ${index}`,
      );
    }
    assert(
      typeof version === 'string',
      `Safe deployment version must be a string: ${stringifyValueForError(version)}`,
    );
    const normalizedVersion = version.trim();
    assert(normalizedVersion.length > 0, 'Safe deployment version is required');
    let multiSendCallOnlyDeployments;
    let multiSendDeployments;
    try {
      multiSendCallOnlyDeployments = getMultiSendCallOnlyDeployments({
        version: normalizedVersion,
      });
      multiSendDeployments = getMultiSendDeployments({
        version: normalizedVersion,
      });
    } catch {
      throw new Error(
        `MultiSend and MultiSendCallOnly deployments not found for version ${normalizedVersion}`,
      );
    }
    if (!multiSendCallOnlyDeployments || !multiSendDeployments) {
      throw new Error(
        `MultiSend and MultiSendCallOnly deployments not found for version ${normalizedVersion}`,
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
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  let evmChainId: unknown;
  try {
    evmChainId = multiProvider.getEvmChainId(chain);
  } catch (error) {
    throw new Error(
      `Failed to resolve EVM chain id for ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    (typeof evmChainId === 'number' &&
      Number.isSafeInteger(evmChainId) &&
      evmChainId > 0) ||
      (typeof evmChainId === 'string' && evmChainId.trim().length > 0) ||
      (typeof evmChainId === 'bigint' && evmChainId > 0n),
    `EVM chain id must be a positive integer for ${chain}: ${stringifyValueForError(evmChainId)}`,
  );
  const chainId =
    typeof evmChainId === 'string' ? evmChainId.trim() : `${evmChainId}`;

  // Get the safe version
  const safeService = getSafeService(chain, multiProvider);
  let safeInfo: unknown;
  try {
    safeInfo = await safeService.getSafeInfo(normalizedSafeAddress);
  } catch (error) {
    throw new Error(
      `Failed to fetch Safe info for ${normalizedSafeAddress} on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    safeInfo !== null && typeof safeInfo === 'object',
    `Safe info payload must be an object for ${normalizedSafeAddress} on ${chain}: ${stringifyValueForError(safeInfo)}`,
  );
  let rawSafeVersion: unknown;
  try {
    rawSafeVersion = (safeInfo as { version?: unknown }).version;
  } catch {
    throw new Error(
      `Safe info version is inaccessible for ${normalizedSafeAddress} on ${chain}`,
    );
  }
  assert(
    typeof rawSafeVersion === 'string' && rawSafeVersion.trim().length > 0,
    `Safe info version must be a non-empty string for ${normalizedSafeAddress} on ${chain}: ${stringifyValueForError(rawSafeVersion)}`,
  );
  // Remove any build metadata from the version e.g. 1.3.0+L2 --> 1.3.0
  const safeVersion = rawSafeVersion
    .trim()
    .split(' ')[0]
    .split('+')[0]
    .split('-')[0];
  assert(
    safeVersion.length > 0,
    `Safe info version must include semver core for ${normalizedSafeAddress} on ${chain}: ${rawSafeVersion}`,
  );

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
    try {
      multiSend = getMultiSendDeployment({
        version: multiSendVersion,
        network: chainId,
      });
      multiSendCallOnly = getMultiSendCallOnlyDeployment({
        version: multiSendCallOnlyVersion,
        network: chainId,
      });
    } catch (error) {
      throw new Error(
        `Failed to resolve Safe multisend deployments for version ${safeVersion} on chainId ${chainId}: ${stringifyValueForError(error)}`,
      );
    }
  }

  let safeSdk: unknown;
  try {
    // @ts-ignore
    safeSdk = await Safe.init({
      provider: getPrimaryRpcUrl(chain, multiProvider),
      signer,
      safeAddress: normalizedSafeAddress,
      contractNetworks: {
        [chainId]: {
          // Use the safe address for multiSendAddress and multiSendCallOnlyAddress
          // if the contract is not deployed or if the version is not found.
          multiSendAddress:
            multiSend?.networkAddresses[chainId] || normalizedSafeAddress,
          multiSendCallOnlyAddress:
            multiSendCallOnly?.networkAddresses[chainId] ||
            normalizedSafeAddress,
        },
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to initialize Safe SDK for ${normalizedSafeAddress} on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    safeSdk !== null && typeof safeSdk === 'object',
    `Safe SDK instance must be an object: ${stringifyValueForError(safeSdk)}`,
  );
  return safeSdk as Safe.default;
}

export async function createSafeDeploymentTransaction(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  config: SafeDeploymentConfig,
): Promise<{
  safeAddress: Address;
  transaction: SafeDeploymentTransaction;
}> {
  const deploymentConfig =
    config !== null && typeof config === 'object'
      ? (config as { owners?: unknown; threshold?: unknown })
      : undefined;
  assert(
    deploymentConfig,
    `Safe deployment config must be an object: ${stringifyValueForError(config)}`,
  );
  let owners: unknown;
  let threshold: unknown;
  try {
    ({ owners, threshold } = deploymentConfig);
  } catch {
    throw new Error('Safe deployment config fields are inaccessible');
  }
  assertValidUniqueOwners(owners, 'safe deployment');
  const normalizedOwners = owners.map((owner) => getAddress(owner));
  assert(
    typeof threshold === 'number' &&
      Number.isSafeInteger(threshold) &&
      threshold > 0 &&
      threshold <= normalizedOwners.length,
    `Safe deployment threshold must be a positive safe integer <= owners length: ${stringifyValueForError(threshold)}`,
  );
  const safeAccountConfig: SafeAccountConfig = {
    owners: normalizedOwners,
    threshold,
  };

  let safe: unknown;
  try {
    // @ts-ignore
    safe = await Safe.init({
      provider: getPrimaryRpcUrl(chain, multiProvider),
      predictedSafe: {
        safeAccountConfig,
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to initialize Safe SDK for deployment on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    safe !== null && typeof safe === 'object',
    `Safe SDK deployment instance must be an object: ${stringifyValueForError(safe)}`,
  );
  let createDeploymentTx: unknown;
  let getSafeAddress: unknown;
  try {
    ({
      createSafeDeploymentTransaction: createDeploymentTx,
      getAddress: getSafeAddress,
    } = safe as {
      createSafeDeploymentTransaction?: unknown;
      getAddress?: unknown;
    });
  } catch {
    throw new Error(
      'Safe SDK deployment transaction/address accessors are inaccessible',
    );
  }
  assert(
    typeof createDeploymentTx === 'function',
    `Safe SDK createSafeDeploymentTransaction must be a function: ${stringifyValueForError(createDeploymentTx)}`,
  );
  assert(
    typeof getSafeAddress === 'function',
    `Safe SDK getAddress must be a function: ${stringifyValueForError(getSafeAddress)}`,
  );
  let deploymentTransaction: unknown;
  try {
    deploymentTransaction = await createDeploymentTx.call(safe);
  } catch (error) {
    throw new Error(
      `Failed to create Safe deployment transaction on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    deploymentTransaction !== null && typeof deploymentTransaction === 'object',
    `Safe deployment transaction payload must be an object: ${stringifyValueForError(deploymentTransaction)}`,
  );
  let to: unknown;
  let data: unknown;
  let value: unknown;
  try {
    ({ to, data, value } = deploymentTransaction as {
      to?: unknown;
      data?: unknown;
      value?: unknown;
    });
  } catch {
    throw new Error(
      'Safe deployment transaction payload fields are inaccessible',
    );
  }
  assert(
    typeof to === 'string' && ethers.utils.isAddress(to),
    `Safe deployment tx target must be valid address for ${chain}: ${stringifyValueForError(to)}`,
  );
  const normalizedData = asHex(data, {
    required: `Safe deployment tx calldata is required for ${chain}`,
    invalid: `Safe deployment tx calldata must be hex for ${chain}: ${stringifyValueForError(data)}`,
  });
  const normalizedValue = parseNonNegativeBigNumber(
    value,
    `Safe deployment tx value must be a non-negative integer for ${chain}: ${stringifyValueForError(value)}`,
  ).toString();
  let safeAddress: unknown;
  try {
    safeAddress = await getSafeAddress.call(safe);
  } catch (error) {
    throw new Error(
      `Failed to derive predicted Safe address for ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    typeof safeAddress === 'string' && ethers.utils.isAddress(safeAddress),
    `Predicted Safe address must be valid for ${chain}: ${stringifyValueForError(safeAddress)}`,
  );
  const normalizedSafeAddress = getAddress(safeAddress);

  return {
    safeAddress: normalizedSafeAddress,
    transaction: {
      to: getAddress(to),
      data: normalizedData,
      value: normalizedValue,
    },
  };
}

export async function getSafeDelegates(
  service: SafeApiKit.default,
  safeAddress: Address,
): Promise<string[]> {
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  const safeService =
    service !== null && typeof service === 'object'
      ? (service as { getSafeDelegates?: unknown })
      : undefined;
  assert(
    safeService,
    `Safe service instance must be an object: ${stringifyValueForError(service)}`,
  );
  let getSafeDelegatesMethod: unknown;
  try {
    ({ getSafeDelegates: getSafeDelegatesMethod } = safeService);
  } catch {
    throw new Error('Safe service getSafeDelegates accessor is inaccessible');
  }
  assert(
    typeof getSafeDelegatesMethod === 'function',
    `Safe service getSafeDelegates must be a function: ${stringifyValueForError(getSafeDelegatesMethod)}`,
  );
  let delegateResponse: unknown;
  try {
    delegateResponse = await getSafeDelegatesMethod.call(safeService, {
      safeAddress: normalizedSafeAddress,
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch Safe delegates for ${normalizedSafeAddress}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    delegateResponse !== null && typeof delegateResponse === 'object',
    `Safe delegates payload must be an object: ${stringifyValueForError(delegateResponse)}`,
  );
  let results: unknown;
  try {
    results = (delegateResponse as { results?: unknown }).results;
  } catch {
    throw new Error('Safe delegates list is inaccessible');
  }
  assert(
    Array.isArray(results),
    `Safe delegates list must be an array: ${stringifyValueForError(results)}`,
  );
  const delegates: string[] = [];
  let delegateCount = 0;
  try {
    delegateCount = results.length;
  } catch {
    throw new Error('Safe delegates list length is inaccessible');
  }
  assert(
    Number.isSafeInteger(delegateCount) && delegateCount >= 0,
    `Safe delegates list length is invalid: ${stringifyValueForError(delegateCount)}`,
  );
  for (let index = 0; index < delegateCount; index += 1) {
    let delegateEntry: unknown;
    try {
      delegateEntry = results[index];
    } catch {
      throw new Error(`Safe delegate entry is inaccessible at index ${index}`);
    }
    assert(
      delegateEntry !== null && typeof delegateEntry === 'object',
      `Safe delegate entry must be an object at index ${index}: ${stringifyValueForError(delegateEntry)}`,
    );
    let delegateAddress: unknown;
    try {
      delegateAddress = (delegateEntry as { delegate?: unknown }).delegate;
    } catch {
      throw new Error(
        `Safe delegate address is inaccessible at index ${index}`,
      );
    }
    assert(
      typeof delegateAddress === 'string' &&
        ethers.utils.isAddress(delegateAddress),
      `Safe delegate address must be valid at index ${index}: ${stringifyValueForError(delegateAddress)}`,
    );
    delegates.push(getAddress(delegateAddress));
  }
  return delegates;
}

export async function canProposeSafeTransactions(
  proposer: Address,
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<boolean> {
  const normalizedProposer = normalizeSafeAddress(proposer);
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  let safeService: SafeApiKit.default;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch {
    return false;
  }
  let safe: Safe.default;
  try {
    safe = await getSafe(chain, multiProvider, normalizedSafeAddress);
  } catch {
    return false;
  }
  let delegates: string[];
  try {
    delegates = await getSafeDelegates(safeService, normalizedSafeAddress);
  } catch {
    return false;
  }
  let ownersRaw: unknown;
  try {
    ownersRaw = await safe.getOwners();
  } catch {
    return false;
  }
  if (!Array.isArray(ownersRaw)) {
    return false;
  }
  const owners = ownersRaw
    .filter((owner): owner is string => typeof owner === 'string')
    .filter((owner) => ethers.utils.isAddress(owner))
    .map((owner) => getAddress(owner));
  return (
    delegates.some((delegate) => eqAddress(delegate, normalizedProposer)) ||
    owners.some((owner) => eqAddress(owner, normalizedProposer))
  );
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

export async function isLegacySafeApi(version?: unknown): Promise<boolean> {
  if (
    version === undefined ||
    version === null ||
    version === '' ||
    (typeof version === 'string' && version.trim().length === 0)
  ) {
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
  if (signer !== undefined && signer !== null) {
    if (typeof signer === 'string') {
      const normalizedExplicitSigner = signer.trim();
      if (ethers.utils.isAddress(normalizedExplicitSigner)) {
        return getAddress(normalizedExplicitSigner);
      }
      const explicitSignerValidationError = `Explicit Safe signer string must be a valid address or 32-byte hex private key: ${stringifyValueForError(signer)}`;
      const normalizedSignerPrivateKey = asHex(normalizedExplicitSigner, {
        required: explicitSignerValidationError,
        invalid: explicitSignerValidationError,
      });
      assert(
        ethers.utils.isHexString(normalizedSignerPrivateKey, 32),
        explicitSignerValidationError,
      );
      return normalizedSignerPrivateKey;
    }
    assert(
      typeof signer === 'object' || typeof signer === 'function',
      `Explicit Safe signer must be a signer object, address, or 32-byte hex private key: ${stringifyValueForError(signer)}`,
    );
    return signer;
  }

  let multiProviderSigner: unknown;
  try {
    multiProviderSigner = signerProvider.getSigner(chain);
  } catch (error) {
    throw new Error(
      `Failed to resolve signer from MultiProvider on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    multiProviderSigner !== null && typeof multiProviderSigner === 'object',
    `Resolved MultiProvider signer must be an object: ${stringifyValueForError(multiProviderSigner)}`,
  );
  let privateKey: unknown;
  try {
    privateKey = (multiProviderSigner as { privateKey?: unknown }).privateKey;
  } catch {
    throw new Error('Resolved MultiProvider signer privateKey is inaccessible');
  }
  if (privateKey !== undefined && privateKey !== null) {
    assert(
      typeof privateKey === 'string' && privateKey.length > 0,
      `Resolved MultiProvider private key must be a non-empty string: ${stringifyValueForError(privateKey)}`,
    );
    const privateKeyValidationError = `Resolved MultiProvider private key must be 32-byte hex: ${stringifyValueForError(privateKey)}`;
    const normalizedPrivateKey = asHex(privateKey, {
      required: privateKeyValidationError,
      invalid: privateKeyValidationError,
    });
    assert(
      ethers.utils.isHexString(normalizedPrivateKey, 32),
      privateKeyValidationError,
    );
    return normalizedPrivateKey;
  }

  let getSignerAddress: unknown;
  try {
    ({ getAddress: getSignerAddress } = multiProviderSigner as {
      getAddress?: unknown;
    });
  } catch {
    throw new Error('Resolved MultiProvider signer getAddress is inaccessible');
  }
  assert(
    typeof getSignerAddress === 'function',
    `Resolved MultiProvider signer getAddress must be a function: ${stringifyValueForError(getSignerAddress)}`,
  );
  let signerAddress: unknown;
  try {
    signerAddress = await getSignerAddress.call(multiProviderSigner);
  } catch (error) {
    throw new Error(
      `Failed to resolve signer address from MultiProvider on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    typeof signerAddress === 'string' && ethers.utils.isAddress(signerAddress),
    `Resolved signer address must be valid: ${stringifyValueForError(signerAddress)}`,
  );
  rootLogger.debug(
    `MultiProvider signer ${signerAddress} on ${chain} does not expose a private key. ` +
      'Falling back to address-based signer configuration for protocol-kit.',
  );
  return getAddress(signerAddress);
}

export async function getSafeAndService(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  signer?: SafeProviderConfig['signer'],
): Promise<SafeAndService> {
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  let safeService: SafeApiKit.default;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (error) {
    throw new Error(
      `Failed to initialize Safe service for chain ${chain}: ${error}`,
    );
  }

  const safeServiceObject =
    safeService !== null && typeof safeService === 'object'
      ? (safeService as { getServiceInfo?: unknown })
      : undefined;
  assert(
    safeServiceObject,
    `Safe service instance must be an object: ${stringifyValueForError(safeService)}`,
  );
  let getServiceInfo: unknown;
  try {
    ({ getServiceInfo } = safeServiceObject);
  } catch {
    throw new Error('Safe service getServiceInfo accessor is inaccessible');
  }
  assert(
    typeof getServiceInfo === 'function',
    `Safe service getServiceInfo must be a function: ${stringifyValueForError(getServiceInfo)}`,
  );
  let serviceInfo: unknown;
  try {
    serviceInfo = await retrySafeApi(() =>
      getServiceInfo.call(safeServiceObject),
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch Safe service info for chain ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    serviceInfo !== null && typeof serviceInfo === 'object',
    `Safe service info payload must be an object for chain ${chain}: ${stringifyValueForError(serviceInfo)}`,
  );
  let version: unknown;
  try {
    version = (serviceInfo as { version?: unknown }).version;
  } catch {
    throw new Error(`Safe service version is inaccessible for chain ${chain}`);
  }
  assert(
    typeof version === 'string' && version.trim().length > 0,
    `Safe service version must be a non-empty string for chain ${chain}: ${stringifyValueForError(version)}`,
  );
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
      getSafe(chain, multiProvider, normalizedSafeAddress, safeSigner),
    );
  } catch (error) {
    throw new Error(`Failed to initialize Safe for chain ${chain}: ${error}`);
  }
  return { safeSdk, safeService };
}

export function createSafeTransactionData(call: unknown): MetaTransactionData {
  const callData =
    call !== null && typeof call === 'object'
      ? (call as ParseableSafeCallData)
      : undefined;
  assert(
    callData,
    `Safe call payload must be an object: ${stringifyValueForError(call)}`,
  );
  let to: unknown;
  let data: unknown;
  let value: unknown;
  try {
    ({ to, data, value } = callData);
  } catch {
    throw new Error(SAFE_CALL_PAYLOAD_INACCESSIBLE_ERROR);
  }
  assert(
    typeof to === 'string' && ethers.utils.isAddress(to),
    `Safe call target must be valid address: ${stringifyValueForError(to)}`,
  );
  const normalizedData = asHex(data, {
    required: 'Safe call data is required',
    invalid: 'Safe call data must be hex',
  });
  return {
    to: getAddress(to),
    data: normalizedData,
    value: serializeSafeCallValue(value),
  };
}

export async function createSafeTransaction(
  safeSdk: Safe.default,
  transactions: MetaTransactionData[],
  onlyCalls?: boolean,
  nonce?: number,
): Promise<SafeTransaction> {
  const safeSdkObject =
    safeSdk !== null && typeof safeSdk === 'object'
      ? (safeSdk as { createTransaction?: unknown })
      : undefined;
  assert(
    safeSdkObject,
    `Safe SDK instance must be an object: ${stringifyValueForError(safeSdk)}`,
  );
  let createTransaction: unknown;
  try {
    ({ createTransaction } = safeSdkObject);
  } catch {
    throw new Error('Safe SDK createTransaction accessor is inaccessible');
  }
  assert(
    typeof createTransaction === 'function',
    `Safe SDK createTransaction must be a function: ${stringifyValueForError(createTransaction)}`,
  );
  assert(
    Array.isArray(transactions),
    `Safe transaction list must be an array: ${stringifyValueForError(transactions)}`,
  );
  let transactionsCount = 0;
  try {
    transactionsCount = transactions.length;
  } catch {
    throw new Error('Safe transaction list length is inaccessible');
  }
  assert(
    Number.isSafeInteger(transactionsCount) && transactionsCount >= 0,
    `Safe transaction list length is invalid: ${stringifyValueForError(transactionsCount)}`,
  );
  assert(
    transactionsCount > 0,
    'Safe transaction list must include at least one call',
  );
  const normalizedTransactions: MetaTransactionData[] = [];
  for (let index = 0; index < transactionsCount; index += 1) {
    let transaction: unknown;
    try {
      transaction = transactions[index];
    } catch {
      throw new Error(
        `Safe transaction entry is inaccessible at index ${index}`,
      );
    }
    assert(
      transaction !== null && typeof transaction === 'object',
      `Safe transaction entry must be an object at index ${index}: ${stringifyValueForError(transaction)}`,
    );
    normalizedTransactions.push(createSafeTransactionData(transaction));
  }
  if (onlyCalls !== undefined) {
    assert(
      typeof onlyCalls === 'boolean',
      `Safe transaction onlyCalls flag must be a boolean: ${stringifyValueForError(onlyCalls)}`,
    );
  }
  if (nonce !== undefined) {
    assert(
      typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0,
      `Safe transaction nonce must be a non-negative safe integer: ${stringifyValueForError(nonce)}`,
    );
  }
  let safeTransaction: unknown;
  try {
    safeTransaction = await createTransaction.call(safeSdkObject, {
      transactions: normalizedTransactions,
      onlyCalls,
      ...(nonce !== undefined ? { options: { nonce: Number(nonce) } } : {}),
    });
  } catch (error) {
    throw new Error(
      `Failed to create Safe transaction: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    safeTransaction !== null && typeof safeTransaction === 'object',
    `Safe SDK createTransaction must return an object: ${stringifyValueForError(safeTransaction)}`,
  );
  let safeTransactionData: unknown;
  try {
    safeTransactionData = (safeTransaction as { data?: unknown }).data;
  } catch {
    throw new Error(SAFE_CREATED_TX_PAYLOAD_INACCESSIBLE_ERROR);
  }
  assert(
    safeTransactionData !== null && typeof safeTransactionData === 'object',
    `Safe SDK transaction data must be an object: ${stringifyValueForError(safeTransactionData)}`,
  );
  return safeTransaction as SafeTransaction;
}

export async function proposeSafeTransaction(
  chain: ChainNameOrId,
  safeSdk: Safe.default,
  safeService: SafeApiKit.default,
  safeTransaction: SafeTransaction,
  safeAddress: Address,
  signer: ethers.Signer,
): Promise<void> {
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  const safeSdkObject =
    safeSdk !== null && typeof safeSdk === 'object'
      ? (safeSdk as {
          getTransactionHash?: unknown;
          signTypedData?: unknown;
        })
      : undefined;
  assert(
    safeSdkObject,
    `Safe SDK instance must be an object: ${stringifyValueForError(safeSdk)}`,
  );
  let getTransactionHash: unknown;
  let signTypedData: unknown;
  try {
    ({ getTransactionHash, signTypedData } = safeSdkObject);
  } catch {
    throw new Error(
      'Safe SDK transaction hash/signature accessors are inaccessible',
    );
  }
  assert(
    typeof getTransactionHash === 'function',
    `Safe SDK getTransactionHash must be a function: ${stringifyValueForError(getTransactionHash)}`,
  );
  assert(
    typeof signTypedData === 'function',
    `Safe SDK signTypedData must be a function: ${stringifyValueForError(signTypedData)}`,
  );
  const safeServiceObject =
    safeService !== null && typeof safeService === 'object'
      ? (safeService as { proposeTransaction?: unknown })
      : undefined;
  assert(
    safeServiceObject,
    `Safe service instance must be an object: ${stringifyValueForError(safeService)}`,
  );
  let proposeTransaction: unknown;
  try {
    ({ proposeTransaction } = safeServiceObject);
  } catch {
    throw new Error('Safe service proposeTransaction accessor is inaccessible');
  }
  assert(
    typeof proposeTransaction === 'function',
    `Safe service proposeTransaction must be a function: ${stringifyValueForError(proposeTransaction)}`,
  );
  assert(
    signer !== null && typeof signer === 'object',
    `Safe signer getAddress must be a function: ${stringifyValueForError(signer)}`,
  );
  let getSignerAddress: unknown;
  try {
    ({ getAddress: getSignerAddress } = signer as { getAddress?: unknown });
  } catch {
    throw new Error('Safe signer getAddress accessor is inaccessible');
  }
  assert(
    typeof getSignerAddress === 'function',
    `Safe signer getAddress must be a function: ${stringifyValueForError(getSignerAddress)}`,
  );
  assert(
    safeTransaction !== null && typeof safeTransaction === 'object',
    `Safe transaction payload must be an object: ${stringifyValueForError(safeTransaction)}`,
  );
  let safeTransactionData: unknown;
  try {
    safeTransactionData = (safeTransaction as { data?: unknown }).data;
  } catch {
    throw new Error('Safe transaction data is inaccessible');
  }
  assert(
    safeTransactionData !== null && typeof safeTransactionData === 'object',
    `Safe transaction data must be an object: ${stringifyValueForError(safeTransactionData)}`,
  );
  assert(
    hasSafeServiceTransactionPayload(safeTransactionData),
    `Safe transaction data payload is invalid: ${stringifyValueForError(safeTransactionData)}`,
  );
  let normalizedSafeTransactionData: Record<string, unknown>;
  try {
    normalizedSafeTransactionData = {
      ...(safeTransactionData as Record<string, unknown>),
      ...createSafeTransactionData(safeTransactionData),
    };
  } catch {
    throw new Error(SAFE_TX_DATA_PAYLOAD_INACCESSIBLE_ERROR);
  }

  let safeTxHash: unknown;
  try {
    safeTxHash = await getTransactionHash.call(safeSdkObject, safeTransaction);
  } catch (error) {
    throw new Error(
      `Failed to derive Safe transaction hash: ${stringifyValueForError(error)}`,
    );
  }
  const normalizedSafeTxHash = normalizeSafeTxHash(safeTxHash);
  let senderSignature: unknown;
  try {
    senderSignature = await signTypedData.call(safeSdkObject, safeTransaction);
  } catch (error) {
    throw new Error(
      `Failed to sign Safe transaction: ${stringifyValueForError(error)}`,
    );
  }
  let senderSignatureData: unknown;
  try {
    senderSignatureData = (senderSignature as { data?: unknown }).data;
  } catch {
    throw new Error('Safe sender signature data is inaccessible');
  }
  assert(
    typeof senderSignatureData === 'string' &&
      senderSignatureData.trim().length > 0,
    `Safe sender signature data must be a non-empty string: ${stringifyValueForError(senderSignatureData)}`,
  );
  const normalizedSenderSignatureData = asHex(senderSignatureData, {
    invalid: `Safe sender signature data must be hex: ${stringifyValueForError(senderSignatureData)}`,
  });
  let senderAddress: unknown;
  try {
    senderAddress = await getSignerAddress.call(signer);
  } catch (error) {
    throw new Error(
      `Failed to resolve Safe signer address: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    typeof senderAddress === 'string' && ethers.utils.isAddress(senderAddress),
    `Safe signer address must be valid: ${stringifyValueForError(senderAddress)}`,
  );
  const normalizedSenderAddress = getAddress(senderAddress);

  try {
    await retrySafeApi(() =>
      proposeTransaction.call(safeServiceObject, {
        safeAddress: normalizedSafeAddress,
        safeTransactionData: normalizedSafeTransactionData,
        safeTxHash: normalizedSafeTxHash,
        senderAddress: normalizedSenderAddress,
        senderSignature: normalizedSenderSignatureData,
      }),
    );
  } catch (error) {
    throw new Error(
      `Failed to propose Safe transaction ${normalizedSafeTxHash} on ${chain}: ${stringifyValueForError(error)}`,
    );
  }

  rootLogger.info(
    chalk.green(
      `Proposed transaction on ${chain} with hash ${normalizedSafeTxHash}`,
    ),
  );
}

export async function executeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: unknown,
): Promise<void> {
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  const normalizedSafeTxHash = normalizeSafeTxHash(safeTxHash);
  const { safeSdk, safeService } = await getSafeAndService(
    chain,
    multiProvider,
    normalizedSafeAddress,
  );
  const safeServiceObject =
    safeService !== null && typeof safeService === 'object'
      ? (safeService as {
          getTransaction?: unknown;
          estimateSafeTransaction?: unknown;
        })
      : undefined;
  assert(
    safeServiceObject,
    `Safe service instance must be an object: ${stringifyValueForError(safeService)}`,
  );
  let getTransaction: unknown;
  let estimateSafeTransaction: unknown;
  try {
    ({ getTransaction, estimateSafeTransaction } = safeServiceObject);
  } catch {
    throw new Error(
      'Safe service transaction accessors are inaccessible for executeTx',
    );
  }
  assert(
    typeof getTransaction === 'function',
    `Safe service getTransaction must be a function: ${stringifyValueForError(getTransaction)}`,
  );
  assert(
    typeof estimateSafeTransaction === 'function',
    `Safe service estimateSafeTransaction must be a function: ${stringifyValueForError(estimateSafeTransaction)}`,
  );

  let safeTransaction: unknown;
  try {
    safeTransaction = await retrySafeApi(() =>
      getTransaction.call(safeServiceObject, normalizedSafeTxHash),
    );
  } catch (error) {
    throw new Error(
      `Failed to fetch transaction details for ${normalizedSafeTxHash}: ${stringifyValueForError(error)}`,
    );
  }
  if (safeTransaction === undefined || safeTransaction === null) {
    throw new Error(
      `Failed to fetch transaction details for ${normalizedSafeTxHash}`,
    );
  }
  assert(
    typeof safeTransaction === 'object',
    `Safe transaction details payload must be an object: ${stringifyValueForError(safeTransaction)}`,
  );

  let estimate: unknown;
  try {
    estimate = await retrySafeApi(() =>
      estimateSafeTransaction.call(
        safeServiceObject,
        normalizedSafeAddress,
        safeTransaction,
      ),
    );
  } catch (error) {
    throw new Error(
      `Failed to estimate gas for Safe transaction ${normalizedSafeTxHash} on chain ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    estimate !== null && typeof estimate === 'object',
    `Safe transaction gas estimate payload must be an object: ${stringifyValueForError(estimate)}`,
  );
  let safeTxGas: unknown;
  try {
    safeTxGas = (estimate as { safeTxGas?: unknown }).safeTxGas;
  } catch {
    throw new Error('Safe transaction gas estimate safeTxGas is inaccessible');
  }
  const normalizedSafeTxGas = parseNonNegativeBigNumber(
    safeTxGas,
    `Safe transaction gas estimate safeTxGas must be a non-negative integer: ${stringifyValueForError(safeTxGas)}`,
  );

  let provider: unknown;
  try {
    provider = multiProvider.getProvider(chain);
  } catch (error) {
    throw new Error(
      `Failed to resolve provider for ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    provider !== null && typeof provider === 'object',
    `Resolved provider must be an object for ${chain}: ${stringifyValueForError(provider)}`,
  );
  let getBalance: unknown;
  try {
    ({ getBalance } = provider as { getBalance?: unknown });
  } catch {
    throw new Error(
      `Provider getBalance accessor is inaccessible for ${chain}`,
    );
  }
  assert(
    typeof getBalance === 'function',
    `Provider getBalance must be a function for ${chain}: ${stringifyValueForError(getBalance)}`,
  );
  let balanceValue: unknown;
  try {
    balanceValue = await getBalance.call(provider, normalizedSafeAddress);
  } catch (error) {
    throw new Error(
      `Failed to fetch Safe balance for ${normalizedSafeAddress} on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  const balance = parseNonNegativeBigNumber(
    balanceValue,
    `Safe balance must be a non-negative integer for ${normalizedSafeAddress} on ${chain}: ${stringifyValueForError(balanceValue)}`,
  );

  if (balance.lt(normalizedSafeTxGas)) {
    throw new Error(
      `Safe ${normalizedSafeAddress} on ${chain} has insufficient balance (${balance.toString()}) for estimated gas (${normalizedSafeTxGas.toString()})`,
    );
  }

  const safeSdkObject =
    safeSdk !== null && typeof safeSdk === 'object'
      ? (safeSdk as { executeTransaction?: unknown })
      : undefined;
  assert(
    safeSdkObject,
    `Safe SDK instance must be an object: ${stringifyValueForError(safeSdk)}`,
  );
  let executeTransaction: unknown;
  try {
    ({ executeTransaction } = safeSdkObject);
  } catch {
    throw new Error('Safe SDK executeTransaction accessor is inaccessible');
  }
  assert(
    typeof executeTransaction === 'function',
    `Safe SDK executeTransaction must be a function: ${stringifyValueForError(executeTransaction)}`,
  );
  try {
    await executeTransaction.call(safeSdkObject, safeTransaction);
  } catch (error) {
    throw new Error(
      `Failed to execute Safe transaction ${normalizedSafeTxHash} on ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  rootLogger.info(
    chalk.green.bold(
      `Executed transaction ${normalizedSafeTxHash} on ${chain}`,
    ),
  );
}

export async function getSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeTxHash: unknown,
): Promise<SafeServiceTransaction | undefined> {
  const normalizedSafeTxHash = normalizeSafeTxHash(safeTxHash);
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const headers = getSafeServiceHeaders(chain, multiProvider);
  const txDetailsUrl = `${txServiceUrl}/v2/multisig-transactions/${normalizedSafeTxHash}/`;

  let txDetailsResponse: Response;
  try {
    txDetailsResponse = await retrySafeApi(async () => {
      const response = await fetch(txDetailsUrl, {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response;
    });
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to fetch transaction details for ${normalizedSafeTxHash} after ${SAFE_API_MAX_RETRIES} attempts: ${error}`,
      ),
    );
    return;
  }

  try {
    const txDetails = (await txDetailsResponse.json()) as unknown;
    assert(
      txDetails !== null && typeof txDetails === 'object',
      `Safe transaction details payload must be an object: ${stringifyValueForError(txDetails)}`,
    );
    return txDetails as SafeServiceTransaction;
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to parse transaction details for ${normalizedSafeTxHash}: ${error}`,
      ),
    );
    return;
  }
}

export async function deleteSafeTx(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
  safeTxHash: unknown,
): Promise<void> {
  const normalizedSafeTxHash = normalizeSafeTxHash(safeTxHash);
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  const signer = multiProvider.getSigner(chain) as unknown;
  assert(
    signer !== null && typeof signer === 'object',
    `Safe deletion signer must be an object: ${stringifyValueForError(signer)}`,
  );
  let getSignerAddress: unknown;
  try {
    ({ getAddress: getSignerAddress } = signer as { getAddress?: unknown });
  } catch {
    throw new Error('Safe deletion signer getAddress accessor is inaccessible');
  }
  assert(
    typeof getSignerAddress === 'function',
    `Safe deletion signer getAddress must be a function: ${stringifyValueForError(getSignerAddress)}`,
  );
  const chainId = multiProvider.getEvmChainId(chain);
  if (!chainId) {
    throw new Error(`Chain is not an EVM chain: ${chain}`);
  }
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const headers = getSafeServiceHeaders(chain, multiProvider);

  const txDetailsUrl = `${txServiceUrl}/v2/multisig-transactions/${normalizedSafeTxHash}/`;
  let txDetailsResponse: Response;
  try {
    txDetailsResponse = await fetch(txDetailsUrl, {
      method: 'GET',
      headers,
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch transaction details for ${normalizedSafeTxHash}: ${stringifyValueForError(error)}`,
    );
  }

  if (!txDetailsResponse.ok) {
    rootLogger.error(
      chalk.red(
        `Failed to fetch transaction details for ${normalizedSafeTxHash}: Status ${txDetailsResponse.status} ${txDetailsResponse.statusText}`,
      ),
    );
    return;
  }

  let txDetails: unknown;
  try {
    txDetails = (await txDetailsResponse.json()) as unknown;
  } catch {
    throw new Error('Safe transaction details payload is inaccessible');
  }
  assert(
    txDetails !== null && typeof txDetails === 'object',
    `Safe transaction details payload must be an object: ${stringifyValueForError(txDetails)}`,
  );
  let proposer: unknown;
  try {
    proposer = (txDetails as SafeServiceTransaction).proposer;
  } catch {
    throw new Error('Safe transaction proposer is inaccessible');
  }
  assert(
    typeof proposer === 'string' && ethers.utils.isAddress(proposer),
    `Safe transaction proposer must be valid address: ${stringifyValueForError(proposer)}`,
  );
  const normalizedProposer = getAddress(proposer);

  let signerAddress: unknown;
  try {
    signerAddress = await getSignerAddress.call(signer);
  } catch (error) {
    throw new Error(
      `Failed to resolve Safe deletion signer address: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    typeof signerAddress === 'string' && ethers.utils.isAddress(signerAddress),
    `Safe deletion signer address must be valid: ${stringifyValueForError(signerAddress)}`,
  );
  const normalizedSignerAddress = getAddress(signerAddress);

  if (!eqAddress(normalizedProposer, normalizedSignerAddress)) {
    rootLogger.info(
      chalk.italic(
        `Skipping deletion of transaction ${normalizedSafeTxHash} proposed by ${normalizedProposer}`,
      ),
    );
    return;
  }
  rootLogger.info(
    `Deleting transaction ${normalizedSafeTxHash} proposed by ${normalizedProposer}`,
  );

  try {
    assertEip712Signer(signer as ethers.Signer);
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
        verifyingContract: normalizedSafeAddress,
      },
      primaryType: 'DeleteRequest',
      message: {
        safeTxHash: normalizedSafeTxHash,
        totp,
      },
    };

    const signature = await (signer as Eip712Signer)._signTypedData(
      typedData.domain,
      { DeleteRequest: typedData.types.DeleteRequest },
      typedData.message,
    );

    const deleteUrl = `${txServiceUrl}/v2/multisig-transactions/${normalizedSafeTxHash}/`;
    const res = await fetch(deleteUrl, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ safeTxHash: normalizedSafeTxHash, signature }),
    });

    if (res.status === 204) {
      rootLogger.info(
        chalk.green(
          `Successfully deleted transaction ${normalizedSafeTxHash} on ${chain}`,
        ),
      );
      return;
    }

    let errorBody = '<unavailable>';
    try {
      errorBody = await res.text();
    } catch (error) {
      errorBody = `<unavailable: ${stringifyValueForError(error)}>`;
    }
    rootLogger.error(
      chalk.red(
        `Failed to delete transaction ${normalizedSafeTxHash} on ${chain}: Status ${res.status} ${res.statusText}. Response body: ${errorBody}`,
      ),
    );
  } catch (error) {
    rootLogger.error(
      chalk.red(
        `Failed to delete transaction ${normalizedSafeTxHash} on ${chain}:`,
      ),
      error,
    );
  }
}

export async function deleteAllPendingSafeTxs(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
  safeAddress: Address,
): Promise<void> {
  const normalizedSafeAddress = normalizeSafeAddress(safeAddress);
  const txServiceUrl = getSafeTxServiceUrl(chain, multiProvider);
  const headers = getSafeServiceHeaders(chain, multiProvider);
  const pendingTxsUrl = `${txServiceUrl}/v2/safes/${normalizedSafeAddress}/multisig-transactions/?executed=false&limit=100`;
  let pendingTxsResponse: Response;
  try {
    pendingTxsResponse = await fetch(pendingTxsUrl, {
      method: 'GET',
      headers,
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch pending Safe transactions for ${normalizedSafeAddress}: ${stringifyValueForError(error)}`,
    );
  }

  if (!pendingTxsResponse.ok) {
    rootLogger.error(
      chalk.red(
        `Failed to fetch pending transactions for ${normalizedSafeAddress}: Status ${pendingTxsResponse.status} ${pendingTxsResponse.statusText}`,
      ),
    );
    return;
  }

  let pendingTxs: unknown;
  try {
    pendingTxs = (await pendingTxsResponse.json()) as unknown;
  } catch {
    throw new Error('Pending Safe transactions payload is inaccessible');
  }
  assert(
    pendingTxs !== null && typeof pendingTxs === 'object',
    `Pending Safe transactions payload must be an object: ${stringifyValueForError(pendingTxs)}`,
  );
  let pendingTxResults: unknown;
  try {
    pendingTxResults = (pendingTxs as SafeServicePendingTransactionsResponse)
      .results;
  } catch {
    throw new Error('Pending Safe transactions list is inaccessible');
  }
  assert(
    Array.isArray(pendingTxResults),
    `Pending Safe transactions list must be an array: ${stringifyValueForError(pendingTxResults)}`,
  );
  let pendingTxCount = 0;
  try {
    pendingTxCount = pendingTxResults.length;
  } catch {
    throw new Error('Pending Safe transactions list length is inaccessible');
  }
  assert(
    Number.isSafeInteger(pendingTxCount) && pendingTxCount >= 0,
    `Pending Safe transactions list length is invalid: ${stringifyValueForError(pendingTxCount)}`,
  );

  for (let index = 0; index < pendingTxCount; index += 1) {
    let pendingTxEntry: unknown;
    try {
      pendingTxEntry = pendingTxResults[index];
    } catch {
      rootLogger.error(
        chalk.red(
          `Failed to read pending transaction entry at index ${index} on ${chain}`,
        ),
      );
      continue;
    }
    if (pendingTxEntry === null || typeof pendingTxEntry !== 'object') {
      rootLogger.error(
        chalk.red(
          `Pending Safe transaction entry must be an object at index ${index}: ${stringifyValueForError(pendingTxEntry)}`,
        ),
      );
      continue;
    }
    let pendingTxHash: unknown;
    try {
      pendingTxHash = (pendingTxEntry as { safeTxHash?: unknown }).safeTxHash;
    } catch {
      rootLogger.error(
        chalk.red(
          `Failed to read pending transaction hash at index ${index} on ${chain}`,
        ),
      );
      continue;
    }
    try {
      await deleteSafeTx(
        chain,
        multiProvider,
        normalizedSafeAddress,
        pendingTxHash,
      );
    } catch (error) {
      rootLogger.error(
        chalk.red(
          `Failed to delete pending transaction ${stringifyValueForError(pendingTxHash)} at index ${index} on ${chain}`,
        ),
        error,
      );
    }
  }

  rootLogger.info(
    `Deleted all pending transactions on ${chain} for ${normalizedSafeAddress}\n`,
  );
}

function assertValidUniqueOwners(
  owners: unknown,
  ownerGroupName: string,
): asserts owners is Address[] {
  assert(
    Array.isArray(owners),
    `Owner list for ${ownerGroupName} must be an array: ${stringifyValueForError(owners)}`,
  );
  const seenOwners = new Set<string>();
  let ownerCount = 0;
  try {
    ownerCount = owners.length;
  } catch {
    throw new Error(`Owner list length is inaccessible for ${ownerGroupName}`);
  }
  assert(
    Number.isSafeInteger(ownerCount) && ownerCount >= 0,
    `Owner list length is invalid for ${ownerGroupName}: ${stringifyValueForError(ownerCount)}`,
  );

  for (let index = 0; index < ownerCount; index += 1) {
    let owner: unknown;
    try {
      owner = owners[index];
    } catch {
      throw new Error(
        `Owner entry is inaccessible for ${ownerGroupName} at index ${index}`,
      );
    }
    assert(
      typeof owner === 'string' && ethers.utils.isAddress(owner),
      `Invalid owner address found in ${ownerGroupName}: ${stringifyValueForError(owner)}`,
    );
    const normalizedOwner = owner.toLowerCase();
    assert(
      !seenOwners.has(normalizedOwner),
      `Duplicate owner address found in ${ownerGroupName}: ${owner}`,
    );
    seenOwners.add(normalizedOwner);
  }
}

export async function getOwnerChanges(
  currentOwners: unknown,
  expectedOwners: unknown,
): Promise<{
  ownersToRemove: Address[];
  ownersToAdd: Address[];
}> {
  assertValidUniqueOwners(currentOwners, 'current owners');
  assertValidUniqueOwners(expectedOwners, 'expected owners');
  const normalizedCurrentOwners = currentOwners.map((owner) =>
    getAddress(owner),
  );
  const normalizedExpectedOwners = expectedOwners.map((owner) =>
    getAddress(owner),
  );

  const ownersToRemove = normalizedCurrentOwners.filter(
    (owner) =>
      !normalizedExpectedOwners.some((newOwner) => eqAddress(owner, newOwner)),
  );
  const ownersToAdd = normalizedExpectedOwners.filter(
    (newOwner) =>
      !normalizedCurrentOwners.some((owner) => eqAddress(newOwner, owner)),
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
  assert(
    ownersToRemove.length === ownersToAdd.length,
    `Owner swap inputs must have equal length: removals=${ownersToRemove.length}, additions=${ownersToAdd.length}`,
  );
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
  let safeAddress: unknown;
  try {
    safeAddress = await safeSdk.getAddress();
  } catch (error) {
    throw new Error(
      `Failed to resolve Safe address while generating owner swap transactions: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    typeof safeAddress === 'string' && ethers.utils.isAddress(safeAddress),
    `Safe address for owner swap transactions must be valid: ${stringifyValueForError(safeAddress)}`,
  );
  const normalizedSafeAddress = getAddress(safeAddress);

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
      to: normalizedSafeAddress,
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
  let thresholdTransaction: unknown;
  try {
    thresholdTransaction = await safeSdk.createChangeThresholdTx(newThreshold);
  } catch (error) {
    throw new Error(
      `Failed to create Safe threshold transaction: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    thresholdTransaction !== null && typeof thresholdTransaction === 'object',
    `Safe threshold transaction payload must be an object: ${stringifyValueForError(thresholdTransaction)}`,
  );
  let thresholdTxData: unknown;
  try {
    thresholdTxData = (thresholdTransaction as { data?: unknown }).data;
  } catch {
    throw new Error('Safe threshold transaction data payload is inaccessible');
  }
  assert(
    thresholdTxData !== null && typeof thresholdTxData === 'object',
    `Safe threshold transaction data must be an object: ${stringifyValueForError(thresholdTxData)}`,
  );
  let to: unknown;
  let data: unknown;
  let value: unknown;
  try {
    ({ to, data, value } = thresholdTxData as {
      to?: unknown;
      data?: unknown;
      value?: unknown;
    });
  } catch {
    throw new Error('Safe threshold transaction fields are inaccessible');
  }
  assert(
    typeof to === 'string' && ethers.utils.isAddress(to),
    `Safe threshold transaction target must be valid address: ${stringifyValueForError(to)}`,
  );
  const normalizedData = asHex(data, {
    required: 'Safe threshold transaction data is required',
    invalid: `Safe threshold transaction data must be hex: ${stringifyValueForError(data)}`,
  });
  const normalizedValue = parseNonNegativeBigNumber(
    value,
    `Safe threshold transaction value must be a non-negative integer: ${stringifyValueForError(value)}`,
  );
  return {
    to: getAddress(to),
    data: normalizedData,
    value: normalizedValue,
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
  const safeSdkObject =
    safeSdk !== null && typeof safeSdk === 'object'
      ? (safeSdk as {
          getThreshold?: unknown;
          getOwners?: unknown;
          getAddress?: unknown;
          createChangeThresholdTx?: unknown;
        })
      : undefined;
  assert(
    safeSdkObject,
    `Safe SDK instance must be an object: ${stringifyValueForError(safeSdk)}`,
  );
  let getThreshold: unknown;
  let getOwners: unknown;
  let getSafeAddressMethod: unknown;
  let createChangeThresholdTx: unknown;
  try {
    ({
      getThreshold,
      getOwners,
      getAddress: getSafeAddressMethod,
      createChangeThresholdTx,
    } = safeSdkObject);
  } catch {
    throw new Error(
      'Safe owner update accessors are inaccessible on Safe SDK instance',
    );
  }
  assert(
    typeof getThreshold === 'function',
    `Safe SDK getThreshold must be a function: ${stringifyValueForError(getThreshold)}`,
  );
  assert(
    typeof getOwners === 'function',
    `Safe SDK getOwners must be a function: ${stringifyValueForError(getOwners)}`,
  );

  let currentThresholdRaw: unknown;
  try {
    currentThresholdRaw = await getThreshold.call(safeSdkObject);
  } catch (error) {
    throw new Error(
      `Failed to fetch Safe threshold: ${stringifyValueForError(error)}`,
    );
  }
  const currentThreshold = parsePositiveSafeInteger(
    currentThresholdRaw,
    `Safe threshold must be a positive integer: ${stringifyValueForError(currentThresholdRaw)}`,
  );
  let newThresholdRaw: unknown;
  if (threshold !== undefined) {
    newThresholdRaw = threshold;
  } else {
    newThresholdRaw = currentThreshold;
  }
  const newThreshold = parsePositiveSafeInteger(
    newThresholdRaw,
    `Safe threshold override must be a positive integer: ${stringifyValueForError(newThresholdRaw)}`,
  );

  let currentOwnersRaw: unknown;
  try {
    currentOwnersRaw = await getOwners.call(safeSdkObject);
  } catch (error) {
    throw new Error(
      `Failed to fetch Safe owners: ${stringifyValueForError(error)}`,
    );
  }
  assertValidUniqueOwners(currentOwnersRaw, 'current owners');
  const currentOwners = currentOwnersRaw.map((owner) => getAddress(owner));
  const expectedOwnersRaw = owners ?? currentOwners;
  assertValidUniqueOwners(expectedOwnersRaw, 'expected owners');
  const expectedOwners = expectedOwnersRaw.map((owner) => getAddress(owner));
  assert(
    newThreshold <= expectedOwners.length,
    `Safe threshold ${newThreshold} exceeds owner count ${expectedOwners.length}`,
  );

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
    assert(
      typeof getSafeAddressMethod === 'function',
      `Safe SDK getAddress must be a function: ${stringifyValueForError(getSafeAddressMethod)}`,
    );
    const swapTxs = await createSwapOwnerTransactions(
      safeSdk,
      currentOwners,
      ownersToRemove,
      ownersToAdd,
    );
    transactions.push(...swapTxs);
  }

  if (currentThreshold !== newThreshold) {
    assert(
      typeof createChangeThresholdTx === 'function',
      `Safe SDK createChangeThresholdTx must be a function: ${stringifyValueForError(createChangeThresholdTx)}`,
    );
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
  assert(
    Array.isArray(chains),
    `Safe chain list must be an array: ${stringifyValueForError(chains)}`,
  );
  assert(
    safes !== null && typeof safes === 'object',
    `Safe map must be an object: ${stringifyValueForError(safes)}`,
  );
  let chainCount = 0;
  try {
    chainCount = chains.length;
  } catch {
    throw new Error('Safe chain list length is inaccessible');
  }
  assert(
    Number.isSafeInteger(chainCount) && chainCount >= 0,
    `Safe chain list length is invalid: ${stringifyValueForError(chainCount)}`,
  );
  const txs: SafeStatus[] = [];
  await Promise.all(
    chains.map(async (chain) => {
      let safeAddress: unknown;
      try {
        safeAddress = safes[chain];
      } catch {
        rootLogger.error(
          chalk.red.bold(`Safe address is inaccessible for ${chain}`),
        );
        return;
      }
      if (!safeAddress) {
        rootLogger.error(chalk.red.bold(`No safe found for ${chain}`));
        return;
      }
      let normalizedSafeAddress: Address;
      try {
        normalizedSafeAddress = normalizeSafeAddress(safeAddress);
      } catch (error) {
        rootLogger.error(
          chalk.red.bold(
            `Invalid safe configured for ${chain}: ${stringifyValueForError(error)}`,
          ),
        );
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
          normalizedSafeAddress,
        ));
      } catch (error) {
        rootLogger.warn(
          chalk.yellow(
            `Skipping chain ${chain} as there was an error getting the safe service: ${error}`,
          ),
        );
        return;
      }

      let thresholdRaw: unknown;
      try {
        thresholdRaw = await safeSdk.getThreshold();
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to fetch threshold for safe ${normalizedSafeAddress} on ${chain}: ${error}`,
          ),
        );
        return;
      }
      let threshold: number;
      try {
        threshold = parseNonNegativeSafeInteger(
          thresholdRaw,
          `Safe threshold must be a positive integer on ${chain}: ${stringifyValueForError(thresholdRaw)}`,
        );
      } catch (error) {
        rootLogger.error(chalk.red(String(error)));
        return;
      }
      if (threshold === 0) {
        rootLogger.error(
          chalk.red(
            `Safe threshold must be a positive integer on ${chain}: ${stringifyValueForError(thresholdRaw)}`,
          ),
        );
        return;
      }

      let pendingTxs: unknown;
      rootLogger.info(
        chalk.gray.italic(
          `Fetching pending transactions for safe ${normalizedSafeAddress} on ${chain}`,
        ),
      );
      try {
        pendingTxs = await retrySafeApi(() =>
          safeService.getPendingTransactions(normalizedSafeAddress),
        );
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to fetch pending transactions for safe ${normalizedSafeAddress} on ${chain} after ${SAFE_API_MAX_RETRIES} attempts: ${error}`,
          ),
        );
        return;
      }

      if (!pendingTxs || typeof pendingTxs !== 'object') {
        rootLogger.error(
          chalk.red(
            `Pending Safe transaction payload must be an object on ${chain}: ${stringifyValueForError(pendingTxs)}`,
          ),
        );
        return;
      }
      let pendingTxResults: unknown;
      try {
        pendingTxResults = (pendingTxs as SafeMultisigTransactionListResponse)
          .results;
      } catch {
        rootLogger.error(
          chalk.red(
            `Pending Safe transaction list is inaccessible on ${chain}`,
          ),
        );
        return;
      }
      if (!Array.isArray(pendingTxResults)) {
        rootLogger.error(
          chalk.red(
            `Pending Safe transaction list must be an array on ${chain}: ${stringifyValueForError(pendingTxResults)}`,
          ),
        );
        return;
      }
      let pendingTxCount = 0;
      try {
        pendingTxCount = pendingTxResults.length;
      } catch {
        rootLogger.error(
          chalk.red(
            `Pending Safe transaction list length is inaccessible on ${chain}`,
          ),
        );
        return;
      }
      if (!Number.isSafeInteger(pendingTxCount) || pendingTxCount < 0) {
        rootLogger.error(
          chalk.red(
            `Pending Safe transaction list length is invalid on ${chain}: ${stringifyValueForError(pendingTxCount)}`,
          ),
        );
        return;
      }
      if (pendingTxCount === 0) {
        rootLogger.info(
          chalk.gray.italic(
            `No pending transactions found for safe ${normalizedSafeAddress} on ${chain}`,
          ),
        );
        return;
      }

      let safeBalanceRaw: unknown;
      try {
        safeBalanceRaw = await safeSdk.getBalance();
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to fetch Safe balance for ${normalizedSafeAddress} on ${chain}: ${error}`,
          ),
        );
        return;
      }
      let balance: BigNumber;
      try {
        balance = parseNonNegativeBigNumber(
          safeBalanceRaw,
          `Safe balance must be non-negative integer on ${chain}: ${stringifyValueForError(safeBalanceRaw)}`,
        );
      } catch (error) {
        rootLogger.error(chalk.red(String(error)));
        return;
      }
      let nativeToken: unknown;
      try {
        nativeToken = await multiProvider.getNativeToken(chain);
      } catch (error) {
        rootLogger.error(
          chalk.red(
            `Failed to fetch native token metadata for ${chain}: ${error}`,
          ),
        );
        return;
      }
      if (nativeToken === null || typeof nativeToken !== 'object') {
        rootLogger.error(
          chalk.red(
            `Native token metadata must be an object for ${chain}: ${stringifyValueForError(nativeToken)}`,
          ),
        );
        return;
      }
      let nativeTokenSymbol: unknown;
      let nativeTokenDecimals: unknown;
      try {
        ({ symbol: nativeTokenSymbol, decimals: nativeTokenDecimals } =
          nativeToken as {
            symbol?: unknown;
            decimals?: unknown;
          });
      } catch {
        rootLogger.error(
          chalk.red(
            `Native token metadata fields are inaccessible for ${chain}`,
          ),
        );
        return;
      }
      if (
        typeof nativeTokenSymbol !== 'string' ||
        nativeTokenSymbol.trim().length === 0
      ) {
        rootLogger.error(
          chalk.red(
            `Native token symbol must be non-empty string for ${chain}: ${stringifyValueForError(nativeTokenSymbol)}`,
          ),
        );
        return;
      }
      if (
        typeof nativeTokenDecimals !== 'number' ||
        !Number.isSafeInteger(nativeTokenDecimals) ||
        nativeTokenDecimals < 0
      ) {
        rootLogger.error(
          chalk.red(
            `Native token decimals must be non-negative integer for ${chain}: ${stringifyValueForError(nativeTokenDecimals)}`,
          ),
        );
        return;
      }
      const formattedBalance = formatUnits(balance, nativeTokenDecimals);

      pendingTxResults.forEach((pendingTx, index) => {
        if (pendingTx === null || typeof pendingTx !== 'object') {
          rootLogger.error(
            chalk.red(
              `Pending Safe transaction entry must be an object at index ${index} on ${chain}: ${stringifyValueForError(pendingTx)}`,
            ),
          );
          return;
        }
        let nonce: unknown;
        let submissionDate: unknown;
        let safeTxHash: unknown;
        let confirmations: unknown;
        try {
          ({ nonce, submissionDate, safeTxHash, confirmations } = pendingTx as {
            nonce?: unknown;
            submissionDate?: unknown;
            safeTxHash?: unknown;
            confirmations?: unknown;
          });
        } catch {
          rootLogger.error(
            chalk.red(
              `Pending Safe transaction entry fields are inaccessible at index ${index} on ${chain}`,
            ),
          );
          return;
        }
        let normalizedNonce: number;
        try {
          normalizedNonce = parseNonNegativeSafeInteger(
            nonce,
            `Pending Safe transaction nonce must be a non-negative integer at index ${index} on ${chain}: ${stringifyValueForError(nonce)}`,
          );
        } catch (error) {
          rootLogger.error(chalk.red(String(error)));
          return;
        }
        const normalizedSubmissionDate =
          typeof submissionDate === 'string'
            ? new Date(submissionDate)
            : undefined;
        if (
          !normalizedSubmissionDate ||
          Number.isNaN(normalizedSubmissionDate.getTime())
        ) {
          rootLogger.error(
            chalk.red(
              `Pending Safe transaction submission date must be valid at index ${index} on ${chain}: ${stringifyValueForError(submissionDate)}`,
            ),
          );
          return;
        }
        let normalizedSafeTxHash: Hex;
        try {
          normalizedSafeTxHash = normalizeSafeTxHash(safeTxHash);
        } catch (error) {
          rootLogger.error(chalk.red(String(error)));
          return;
        }
        const confs = Array.isArray(confirmations) ? confirmations.length : 0;
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
          nonce: normalizedNonce,
          submissionDate: normalizedSubmissionDate.toDateString(),
          shortTxHash: `${normalizedSafeTxHash.slice(0, 6)}...${normalizedSafeTxHash.slice(-4)}`,
          fullTxHash: normalizedSafeTxHash,
          confs,
          threshold,
          status,
          balance: `${Number(formattedBalance).toFixed(5)} ${nativeTokenSymbol.trim()}`,
        });
      });
    }),
  );
  return txs.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

export type ParseableSafeTx = Omit<AnnotatedEV5Transaction, 'data'> & {
  data?: unknown;
};

export function parseSafeTx(tx: unknown) {
  const txPayload =
    tx !== null && typeof tx === 'object'
      ? (tx as Partial<ParseableSafeTx>)
      : undefined;
  assert(
    txPayload,
    `Safe transaction payload must be an object: ${stringifyValueForError(tx)}`,
  );
  let data: unknown;
  let value: unknown;
  try {
    ({ data, value } = txPayload);
  } catch {
    throw new Error(SAFE_TX_PAYLOAD_INACCESSIBLE_ERROR);
  }
  const normalizedData = asHex(data, {
    required: SAFE_TX_DATA_REQUIRED_ERROR,
    invalid: SAFE_TX_DATA_INVALID_HEX_ERROR,
  });
  assert(
    normalizedData.length >= FUNCTION_SELECTOR_HEX_LENGTH,
    SAFE_TX_SELECTOR_REQUIRED_ERROR,
  );
  return SAFE_INTERFACE.parseTransaction({
    data: normalizedData,
    value: value as AnnotatedEV5Transaction['value'],
  });
}

interface AsHexErrorMessages {
  required?: string;
  invalid?: string;
}

function stringifyValueForError(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unstringifiable>';
  }
}

function getChainMetadataForSafe(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): unknown {
  let chainMetadata: unknown;
  try {
    chainMetadata = multiProvider.getChainMetadata(chain);
  } catch (error) {
    throw new Error(
      `Failed to read chain metadata for ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    chainMetadata !== null && typeof chainMetadata === 'object',
    `Chain metadata must be an object for ${chain}: ${stringifyValueForError(chainMetadata)}`,
  );
  return chainMetadata;
}

function serializeSafeCallValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '0';
  }
  let serializedValue: unknown;
  try {
    serializedValue = value.toString();
  } catch {
    throw new Error(
      `Safe call value must be serializable: ${stringifyValueForError(value)}`,
    );
  }
  assert(
    typeof serializedValue === 'string' &&
      serializedValue.length > 0 &&
      /^\d+$/.test(serializedValue),
    `Safe call value must be an unsigned integer string: ${stringifyValueForError(serializedValue)}`,
  );
  return serializedValue;
}

function getPrimaryRpcUrl(
  chain: ChainNameOrId,
  multiProvider: MultiProvider,
): string {
  let chainMetadata: unknown;
  try {
    chainMetadata = multiProvider.getChainMetadata(chain);
  } catch (error) {
    throw new Error(
      `Failed to read chain metadata for ${chain}: ${stringifyValueForError(error)}`,
    );
  }
  assert(
    chainMetadata !== null && typeof chainMetadata === 'object',
    `Chain metadata must be an object for ${chain}: ${stringifyValueForError(chainMetadata)}`,
  );
  let rpcUrls: unknown;
  try {
    rpcUrls = (chainMetadata as { rpcUrls?: unknown }).rpcUrls;
  } catch {
    throw new Error(`Chain metadata rpcUrls are inaccessible for ${chain}`);
  }
  assert(
    Array.isArray(rpcUrls),
    `Chain metadata rpcUrls must be an array for ${chain}: ${stringifyValueForError(rpcUrls)}`,
  );
  let rpcUrlCount = 0;
  try {
    rpcUrlCount = rpcUrls.length;
  } catch {
    throw new Error(
      `Chain metadata rpcUrls length is inaccessible for ${chain}`,
    );
  }
  assert(
    Number.isSafeInteger(rpcUrlCount) && rpcUrlCount > 0,
    `Chain metadata rpcUrls length is invalid for ${chain}: ${stringifyValueForError(rpcUrlCount)}`,
  );
  let primaryRpcUrlEntry: unknown;
  try {
    primaryRpcUrlEntry = rpcUrls[0];
  } catch {
    throw new Error(`Primary RPC entry is inaccessible for ${chain}`);
  }
  assert(
    primaryRpcUrlEntry !== null && typeof primaryRpcUrlEntry === 'object',
    `Primary RPC entry must be an object for ${chain}: ${stringifyValueForError(primaryRpcUrlEntry)}`,
  );
  let rpcHttp: unknown;
  try {
    rpcHttp = (primaryRpcUrlEntry as { http?: unknown }).http;
  } catch {
    throw new Error(`Primary RPC http URL is inaccessible for ${chain}`);
  }
  assert(
    typeof rpcHttp === 'string' && rpcHttp.trim().length > 0,
    `Primary RPC http URL must be a non-empty string for ${chain}: ${stringifyValueForError(rpcHttp)}`,
  );
  return rpcHttp.trim();
}

function parseNonNegativeBigNumber(
  value: unknown,
  errorMessage: string,
): BigNumber {
  let parsed: BigNumber;
  try {
    parsed = BigNumber.from(value as BigNumber);
  } catch {
    throw new Error(errorMessage);
  }
  assert(parsed.gte(0), errorMessage);
  return parsed;
}

function parseNonNegativeSafeInteger(
  value: unknown,
  errorMessage: string,
): number {
  const parsedBigNumber = parseNonNegativeBigNumber(value, errorMessage);
  assert(
    parsedBigNumber.lte(BigNumber.from(Number.MAX_SAFE_INTEGER.toString())),
    errorMessage,
  );
  return parsedBigNumber.toNumber();
}

function parsePositiveSafeInteger(
  value: unknown,
  errorMessage: string,
): number {
  const parsed = parseNonNegativeSafeInteger(value, errorMessage);
  assert(parsed > 0, errorMessage);
  return parsed;
}

export function asHex(hex?: unknown, errorMessages?: AsHexErrorMessages): Hex {
  const requiredErrorMessage =
    errorMessages?.required ?? 'Hex value is required';
  const invalidErrorMessage = errorMessages?.invalid;
  const resolvedInvalidErrorMessage =
    invalidErrorMessage ??
    `Hex value must be valid hex: ${stringifyValueForError(hex)}`;
  assert(hex !== undefined && hex !== null, requiredErrorMessage);
  assert(typeof hex === 'string', resolvedInvalidErrorMessage);
  const normalizedHex = hex.trim();
  const normalizedInvalidErrorMessage =
    invalidErrorMessage ?? `Hex value must be valid hex: ${normalizedHex}`;
  assert(normalizedHex.length > 0, requiredErrorMessage);
  const lowerCaseHex = normalizedHex.toLowerCase();
  const normalizedBody = lowerCaseHex.startsWith('0x')
    ? lowerCaseHex.slice(2)
    : lowerCaseHex;
  assert(normalizedBody.length % 2 === 0, normalizedInvalidErrorMessage);

  if (isHex(lowerCaseHex)) {
    return lowerCaseHex as Hex;
  }

  const prefixedHex = lowerCaseHex.startsWith('0x')
    ? lowerCaseHex
    : `0x${lowerCaseHex}`;
  assert(isHex(prefixedHex), normalizedInvalidErrorMessage);
  return prefixedHex as Hex;
}

function normalizeSafeAddress(safeAddress: unknown): Address {
  assert(
    typeof safeAddress === 'string' && ethers.utils.isAddress(safeAddress),
    `Safe address must be valid: ${stringifyValueForError(safeAddress)}`,
  );
  return getAddress(safeAddress);
}

function normalizeSafeTxHash(safeTxHash: unknown): Hex {
  const safeTxHashValidationError = `Safe transaction hash must be 32-byte hex: ${stringifyValueForError(safeTxHash)}`;
  const normalizedSafeTxHash = asHex(safeTxHash, {
    required: safeTxHashValidationError,
    invalid: safeTxHashValidationError,
  });
  assert(
    ethers.utils.isHexString(normalizedSafeTxHash, 32),
    safeTxHashValidationError,
  );
  return normalizedSafeTxHash;
}

export function decodeMultiSendData(
  encodedData: unknown,
): MetaTransactionData[] {
  const normalizedData = asHex(encodedData);
  assert(
    normalizedData.length >= FUNCTION_SELECTOR_HEX_LENGTH,
    MULTISEND_SELECTOR_REQUIRED_ERROR,
  );
  const decodedData = decodeFunctionData({
    abi: parseAbi([
      'function multiSend(bytes memory transactions) public payable',
    ]),
    data: normalizedData,
  });

  const args = decodedData.args;
  const txs: MetaTransactionData[] = [];
  if (!args) {
    return txs;
  }

  const [transactionBytes] = args;
  let index = 2;

  const readSegment = (length: number, segmentName: string): string => {
    const nextIndex = index + length;
    assert(
      nextIndex <= transactionBytes.length,
      `Invalid multisend payload: truncated ${segmentName}`,
    );
    const segment = transactionBytes.slice(index, nextIndex);
    index = nextIndex;
    return segment;
  };

  while (index < transactionBytes.length) {
    const operation = Number(`0x${readSegment(2, 'operation')}`);
    assert(
      operation === 0 || operation === 1,
      `Invalid multisend payload: unsupported operation ${operation}`,
    );
    const to = `0x${readSegment(40, 'to')}`;
    const value = `0x${readSegment(64, 'value')}`;
    const dataLengthHex = readSegment(64, 'data length');
    const dataLength = Number.parseInt(dataLengthHex, 16) * 2;
    assert(
      Number.isSafeInteger(dataLength),
      'Invalid multisend payload: malformed data length',
    );
    const data = `0x${readSegment(dataLength, 'data')}`;

    txs.push({
      operation: operation as OperationType,
      to: getAddress(to),
      value: BigInt(value).toString(),
      data,
    });
  }

  return txs;
}
