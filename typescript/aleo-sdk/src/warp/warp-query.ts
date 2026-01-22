import { Plaintext } from '@provablehq/sdk';

import { assert, ensure0x } from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  ALEO_NULL_ADDRESS,
  U128ToString,
  formatAddress,
  fromAleoAddress,
  toAleoAddress,
} from '../utils/helper.js';
import {
  type AleoNativeWarpTokenConfig,
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

  assert(mappingValue, `Token metadata not found for tokenId: ${tokenId}`);

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
      throw new Error(`Unknown token type value: ${value}`);
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

  assert(metadataValue, `Token metadata not found for ${tokenAddress}`);

  const metadata = Plaintext.fromString(metadataValue).toObject();
  const tokenTypeValue = metadata['token_type'];

  assert(
    typeof tokenTypeValue === 'number',
    `Invalid token_type in metadata for ${tokenAddress}`,
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
    `Invalid remote_router_length for ${tokenAddress}: ${routerLengthRes}`,
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

    // Skip duplicates
    if (remoteRouters[domainId]) {
      continue;
    }

    assert(
      remoteRouter['recipient'] instanceof Uint8Array,
      `Invalid recipient format in remote router for domain ${domainId}`,
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

  assert(metadataValue, `Token metadata not found for ${tokenAddress}`);

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
    `Mailbox program not found in imports for ${tokenAddress}`,
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
    `Invalid token_type in metadata for ${tokenAddress}`,
  );

  const tokenType = toAleoTokenType(tokenTypeValue);
  assert(
    tokenType === AleoTokenType.NATIVE,
    `Token at ${tokenAddress} is not a native token (type: ${tokenType})`,
  );

  // Get mailbox
  const mailboxAddress = await getMailboxAddress(aleoClient, tokenAddress);

  // Parse ISM
  const ism = parseIsmAddress(metadata.ism, ismManager);

  // Get remote routers
  const remoteRouters = await getRemoteRouters(aleoClient, tokenAddress);

  return {
    type: AleoTokenType.NATIVE,
    owner: formatAddress(metadata.token_owner),
    mailbox: mailboxAddress,
    ism,
    remoteRouters,
  };
}
