import { Plaintext } from '@provablehq/sdk';

import {
  assert,
  ensure0x,
  isNullish,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  U128ToString,
  fromAleoAddress,
  toAleoAddress,
} from '../utils/helper.js';
import {
  type AleoCollateralWarpTokenConfig,
  type AleoNativeWarpTokenConfig,
  type AleoSyntheticWarpTokenConfig,
  AleoTokenType,
} from '../utils/types.js';

/**
 * Query token metadata from token_registry.aleo
 */
export async function getTokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  tokenId: string,
): Promise<{
  name: string;
  symbol: string;
  decimals: number;
}> {
  const mappingValue = await aleoClient.getProgramMappingValue(
    'token_registry.aleo',
    'registered_tokens',
    tokenId,
  );

  assert(
    mappingValue,
    `Expected token metadata to be registered in token_registry.aleo but none found for tokenId: ${tokenId}`,
  );

  const tokenMetadata = Plaintext.fromString(mappingValue).toObject();

  return {
    name: U128ToString(tokenMetadata['name']),
    symbol: U128ToString(tokenMetadata['symbol']),
    decimals: tokenMetadata['decimals'],
  };
}

/**
 * Convert numeric token type to AleoTokenType enum
 */
function toAleoTokenType(value: number): AleoTokenType {
  switch (value) {
    case AleoTokenType.NATIVE:
      return AleoTokenType.NATIVE;
    case AleoTokenType.SYNTHETIC:
      return AleoTokenType.SYNTHETIC;
    case AleoTokenType.COLLATERAL:
      return AleoTokenType.COLLATERAL;
    default:
      throw new Error(
        `Expected valid token type for aleo contract but got ${value}`,
      );
  }
}

/**
 * Detect the type of an Aleo warp token
 */
export async function getAleoWarpTokenType(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<AleoTokenType> {
  const { programId } = fromAleoAddress(tokenAddress);

  const metadataValue = await aleoClient.getProgramMappingValue(
    programId,
    'app_metadata',
    'true',
  );

  assert(
    metadataValue,
    `Expected app_metadata mapping to exist for token ${tokenAddress} but none found`,
  );

  const metadata = Plaintext.fromString(metadataValue).toObject();
  const tokenTypeValue = metadata['token_type'];

  assert(
    typeof tokenTypeValue === 'number',
    `Expected token_type field to be a number in app_metadata for token ${tokenAddress} but got ${typeof tokenTypeValue}`,
  );

  return toAleoTokenType(tokenTypeValue);
}

/**
 * Query remote router configurations for a warp token
 */
export async function getRemoteRouters(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<Record<number, { address: string; gas: string }>> {
  const { programId } = fromAleoAddress(tokenAddress);

  const remoteRouters: Record<number, { address: string; gas: string }> = {};

  const routerLengthRes = await aleoClient.getProgramMappingValue(
    programId,
    'remote_router_length',
    'true',
  );

  if (!routerLengthRes) {
    return remoteRouters;
  }

  const routerLength = parseInt(routerLengthRes);
  assert(
    !isNaN(routerLength) && routerLength >= 0,
    `Expected remote_router_length to be a non-negative number for token ${tokenAddress} but got ${routerLengthRes}`,
  );

  for (let i = 0; i < routerLength; i++) {
    const routerKey = await aleoClient.getProgramMappingPlaintext(
      programId,
      'remote_router_iter',
      `${i}u32`,
    );

    if (!routerKey) continue;

    const remoteRouterValue = await aleoClient.getProgramMappingValue(
      programId,
      'remote_routers',
      routerKey,
    );

    if (!remoteRouterValue) continue;

    const remoteRouter = Plaintext.fromString(remoteRouterValue).toObject();

    const domainId = Number(remoteRouter['domain']);

    // Skip duplicates (defensive: shouldn't occur in normal operation)
    if (remoteRouters[domainId]) {
      continue;
    }

    assert(
      Array.isArray(remoteRouter['recipient']),
      `Expected recipient to be an array in remote router for domain ${domainId} but got ${typeof remoteRouter['recipient']}`,
    );

    remoteRouters[domainId] = {
      address: ensure0x(Buffer.from(remoteRouter['recipient']).toString('hex')),
      gas: remoteRouter['gas'].toString(),
    };
  }

  return remoteRouters;
}

/**
 * Query app_metadata mapping for a warp token
 */
interface AleoWarpTokenMetadata {
  token_type: number;
  token_owner: string;
  ism: string;
  hook: string;
  token_id?: string;
}

async function getWarpTokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<AleoWarpTokenMetadata> {
  const { programId } = fromAleoAddress(tokenAddress);

  const metadataValue = await aleoClient.getProgramMappingValue(
    programId,
    'app_metadata',
    'true',
  );

  assert(
    metadataValue,
    `Expected app_metadata mapping to exist for token ${tokenAddress} but none found`,
  );

  const metadata = Plaintext.fromString(metadataValue).toObject();
  const tokenType = metadata['token_type'];
  const tokenOwner = metadata['token_owner'];
  const ism = metadata['ism'];
  const hook = metadata['hook'];
  const tokenId = metadata['token_id'];

  assert(
    typeof tokenType === 'number',
    `Expected token_type field to be a number in app_metadata for token ${tokenAddress} but got ${typeof tokenType}`,
  );
  assert(
    typeof tokenOwner === 'string',
    `Expected token_owner field to be a string in app_metadata for token ${tokenAddress} but got ${typeof tokenOwner}`,
  );
  assert(
    typeof ism === 'string',
    `Expected ism field to be a string in app_metadata for token ${tokenAddress} but got ${typeof ism}`,
  );
  assert(
    typeof hook === 'string',
    `Expected hook field to be a string in app_metadata for token ${tokenAddress} but got ${typeof hook}`,
  );
  assert(
    isNullish(tokenId) || typeof tokenId === 'string',
    `Expected token_id field to be a string in app_metadata for token ${tokenAddress} but got ${typeof tokenId}`,
  );

  return {
    token_type: tokenType,
    token_owner: tokenOwner,
    ism,
    hook,
    token_id: tokenId,
  };
}

/**
 * Get mailbox address for a warp token
 */
async function getMailboxAddress(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<{
  mailboxAddress: string;
  ismManagerProgramId?: string;
  hookManagerProgramId?: string;
}> {
  const { programId } = fromAleoAddress(tokenAddress);

  const imports = await aleoClient.getProgramImportNames(programId);
  const mailboxProgramId = imports.find((i) => i.includes('mailbox'));
  const ismManagerProgramId = imports.find((i) => i.includes('ism_manager'));
  const hookManagerProgramId = imports.find((i) => i.includes('hook_manager'));

  assert(
    mailboxProgramId,
    `Expected mailbox program in imports for token ${tokenAddress} but none found`,
  );

  return {
    mailboxAddress: toAleoAddress(mailboxProgramId),
    ismManagerProgramId,
    hookManagerProgramId,
  };
}

/**
 * Parse ISM address from metadata
 */
function formatIsmAddress(
  ismAddress: string,
  ismManager: string,
): string | undefined {
  if (isZeroishAddress(ismAddress)) {
    return undefined;
  }

  return `${ismManager}/${ismAddress}`;
}

/**
 * Parse Hook address from metadata
 */
function formatHookAddress(
  hookAddress: string,
  hookManager: string,
): string | undefined {
  if (isZeroishAddress(hookAddress)) {
    return undefined;
  }

  return `${hookManager}/${hookAddress}`;
}

/**
 * Query native warp token configuration
 */
export async function getNativeWarpTokenConfig(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
  fallbackIsmManager: string,
  fallbackHookManager: string,
): Promise<AleoNativeWarpTokenConfig> {
  // Query metadata
  const metadata = await getWarpTokenMetadata(aleoClient, tokenAddress);

  // Verify token type
  const tokenTypeValue = metadata.token_type;

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.NATIVE,
    `Expected native token (type ${AleoTokenType.NATIVE}) at ${tokenAddress} but got type ${tokenType}`,
  );

  // Get mailbox
  const { mailboxAddress, ismManagerProgramId, hookManagerProgramId } =
    await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = formatIsmAddress(
    metadata.ism,
    ismManagerProgramId || fallbackIsmManager,
  );

  const hook = formatHookAddress(
    metadata.hook,
    hookManagerProgramId || fallbackHookManager,
  );

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  return {
    type: AleoTokenType.NATIVE,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    hook,
    remoteRouters,
  };
}

/**
 * Query collateral warp token configuration
 */
export async function getCollateralWarpTokenConfig(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
  fallbackIsmManager: string,
  fallbackHookManager: string,
): Promise<AleoCollateralWarpTokenConfig> {
  // Query metadata
  const metadata = await getWarpTokenMetadata(aleoClient, tokenAddress);

  // Verify token type
  const tokenTypeValue = metadata.token_type;

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.COLLATERAL,
    `Expected collateral token (type ${AleoTokenType.COLLATERAL}) at ${tokenAddress} but got type ${tokenType}`,
  );

  // Get mailbox
  const { mailboxAddress, ismManagerProgramId, hookManagerProgramId } =
    await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = formatIsmAddress(
    metadata.ism,
    ismManagerProgramId || fallbackIsmManager,
  );

  const hook = formatHookAddress(
    metadata.hook,
    hookManagerProgramId || fallbackHookManager,
  );

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  // Get token ID and metadata from token_registry
  const tokenId = metadata.token_id;
  assert(
    tokenId,
    `Expected token_id field in app_metadata for token ${tokenAddress} but none found`,
  );

  const tokenMetadata = await getTokenMetadata(aleoClient, tokenId);

  return {
    type: AleoTokenType.COLLATERAL,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    hook,
    remoteRouters,
    token: tokenId,
    name: tokenMetadata.name,
    symbol: tokenMetadata.symbol,
    decimals: tokenMetadata.decimals,
  };
}

/**
 * Query synthetic warp token configuration
 */
export async function getSyntheticWarpTokenConfig(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
  fallbackIsmManager: string,
  fallbackHookManager: string,
): Promise<AleoSyntheticWarpTokenConfig> {
  // Query metadata
  const metadata = await getWarpTokenMetadata(aleoClient, tokenAddress);

  // Verify token type
  const tokenTypeValue = metadata.token_type;

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.SYNTHETIC,
    `Expected synthetic token (type ${AleoTokenType.SYNTHETIC}) at ${tokenAddress} but got type ${tokenType}`,
  );

  // Get mailbox
  const { mailboxAddress, ismManagerProgramId, hookManagerProgramId } =
    await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = formatIsmAddress(
    metadata.ism,
    ismManagerProgramId || fallbackIsmManager,
  );

  const hook = formatHookAddress(
    metadata.hook,
    hookManagerProgramId || fallbackHookManager,
  );

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  // Get token ID and metadata from token_registry
  const tokenId = metadata.token_id;
  assert(
    tokenId,
    `Expected token_id field in app_metadata for token ${tokenAddress} but none found`,
  );

  const tokenMetadata = await getTokenMetadata(aleoClient, tokenId);

  return {
    type: AleoTokenType.SYNTHETIC,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    hook,
    remoteRouters,
    name: tokenMetadata.name,
    symbol: tokenMetadata.symbol,
    decimals: tokenMetadata.decimals,
  };
}
