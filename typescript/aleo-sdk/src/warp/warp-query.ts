import { Plaintext } from '@provablehq/sdk';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  ALEO_NULL_ADDRESS,
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
async function getWarpTokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<Record<string, any>> {
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

  return Plaintext.fromString(metadataValue).toObject();
}

/**
 * Get mailbox address for a warp token
 */
async function getMailboxAddress(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
): Promise<string> {
  const { programId } = fromAleoAddress(tokenAddress);

  const imports = await aleoClient.getProgramImportNames(programId);
  const mailboxProgramId = imports.find((i) => i.includes('mailbox'));

  assert(
    mailboxProgramId,
    `Expected mailbox program in imports for token ${tokenAddress} but none found`,
  );

  return toAleoAddress(mailboxProgramId);
}

/**
 * Parse ISM address from metadata
 */
function parseIsmAddress(
  ismAddress: string,
  ismManager: string,
): string | undefined {
  if (ismAddress === ALEO_NULL_ADDRESS) {
    return undefined;
  }

  return `${ismManager}/${ismAddress}`;
}

/**
 * Query native warp token configuration
 */
export async function getNativeWarpTokenConfig(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
  ismManager: string,
): Promise<AleoNativeWarpTokenConfig> {
  // Query metadata
  const metadata = await getWarpTokenMetadata(aleoClient, tokenAddress);

  // Verify token type
  const tokenTypeValue = metadata['token_type'];
  assert(
    typeof tokenTypeValue === 'number',
    `Expected token_type field to be a number in app_metadata for token ${tokenAddress} but got ${typeof tokenTypeValue}`,
  );

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.NATIVE,
    `Expected native token (type ${AleoTokenType.NATIVE}) at ${tokenAddress} but got type ${tokenType}`,
  );

  // Get mailbox
  const mailboxAddress = await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = parseIsmAddress(metadata.ism, ismManager);

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  return {
    type: AleoTokenType.NATIVE,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    remoteRouters,
  };
}

/**
 * Query collateral warp token configuration
 */
export async function getCollateralWarpTokenConfig(
  aleoClient: AnyAleoNetworkClient,
  tokenAddress: string,
  ismManager: string,
): Promise<AleoCollateralWarpTokenConfig> {
  // Query metadata
  const metadata = await getWarpTokenMetadata(aleoClient, tokenAddress);

  // Verify token type
  const tokenTypeValue = metadata['token_type'];
  assert(
    typeof tokenTypeValue === 'number',
    `Expected token_type field to be a number in app_metadata for token ${tokenAddress} but got ${typeof tokenTypeValue}`,
  );

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.COLLATERAL,
    `Expected collateral token (type ${AleoTokenType.COLLATERAL}) at ${tokenAddress} but got type ${tokenType}`,
  );

  // Get mailbox
  const mailboxAddress = await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = parseIsmAddress(metadata.ism, ismManager);

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  // Get token ID and metadata from token_registry
  const tokenId = metadata['token_id'];
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
  ismManager: string,
): Promise<AleoSyntheticWarpTokenConfig> {
  // Query metadata
  const metadata = await getWarpTokenMetadata(aleoClient, tokenAddress);

  // Verify token type
  const tokenTypeValue = metadata['token_type'];
  assert(
    typeof tokenTypeValue === 'number',
    `Expected token_type field to be a number in app_metadata for token ${tokenAddress} but got ${typeof tokenTypeValue}`,
  );

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.SYNTHETIC,
    `Expected synthetic token (type ${AleoTokenType.SYNTHETIC}) at ${tokenAddress} but got type ${tokenType}`,
  );

  // Get mailbox
  const mailboxAddress = await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = parseIsmAddress(metadata.ism, ismManager);

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  // Get token ID and metadata from token_registry
  const tokenId = metadata['token_id'];
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
    remoteRouters,
    name: tokenMetadata.name,
    symbol: tokenMetadata.symbol,
    decimals: tokenMetadata.decimals,
  };
}
