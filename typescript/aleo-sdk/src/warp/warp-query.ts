import { Plaintext } from '@provablehq/sdk';

import {
  assert,
  ensure0x,
  isNullish,
  isZeroishAddress,
  retryAsync,
} from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  U128ToString,
  fromAleoAddress,
  isV2WarpToken,
  toAleoAddress,
} from '../utils/helper.js';
import {
  type AleoCollateralWarpTokenConfig,
  type AleoNativeWarpTokenConfig,
  type AleoSyntheticWarpTokenConfig,
  AleoTokenType,
} from '../utils/types.js';

/**
 * Returns the ARC-20 token program ID imported by an ARC-20-based warp token.
 * The arc20 token import is the one that contains 'arc20' but not 'multisig'.
 */
export async function getArc20ProgramId(
  aleoClient: AnyAleoNetworkClient,
  warpProgramId: string,
): Promise<string> {
  const imports = await aleoClient.getProgramImportNames(warpProgramId);
  const arc20ProgramId = imports.find(
    (i) => i.includes('arc20') && !i.includes('multisig'),
  );
  assert(
    arc20ProgramId,
    `Could not find ARC-20 token import in program ${warpProgramId}`,
  );
  return arc20ProgramId;
}

/**
 * Validates and extracts the first output from a view function response body.
 * Expects a JSON array of wire-format strings (e.g. ["6u8"], ["'USDC'"]).
 */
export function parseViewFunctionOutputs(
  outputs: unknown,
  programId: string,
  viewName: string,
): string {
  assert(
    Array.isArray(outputs) &&
      outputs.length > 0 &&
      typeof outputs[0] === 'string',
    `View function ${programId}/${viewName} returned an unexpected response shape: ${JSON.stringify(outputs)}`,
  );
  return outputs[0];
}

/**
 * Calls a view function on an Aleo program via the Explorer REST API.
 * POST {host}/program/{programId}/view/{viewName}
 * No-input functions use an empty object body `{}`; functions with inputs use a JSON array.
 * Returns the raw wire-format string of the first output (e.g. "6u8", "'USDC'", "1000000u128").
 */
export async function callViewFunction(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  viewName: string,
  inputs: string[] = [],
): Promise<string> {
  const url = `${aleoClient.host}/program/${programId}/view/${viewName}`;
  const body = inputs.length === 0 ? '{}' : JSON.stringify(inputs);
  return retryAsync(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert(res.ok, `View function call failed (${res.status}): ${url}`);
      const outputs: unknown = await res.json();
      return parseViewFunctionOutputs(outputs, programId, viewName);
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
  );
}

/**
 * Parse a raw Aleo uint literal (e.g. "1000000u128", "6u8") to BigInt.
 */
export function parseAleoUint(raw: string): bigint {
  const match = raw.match(/^(\d+)/);
  assert(match, `Expected numeric Aleo literal, got: ${raw}`);
  return BigInt(match[1]);
}

/**
 * Parse a raw Aleo identifier literal (e.g. "'USDC'") to a plain string.
 */
function parseAleoIdentifier(raw: string): string {
  return raw.replace(/^'|'$/g, '');
}

/**
 * Query token metadata from an ARC-20 token program via its view functions.
 */
export async function getArc20TokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  arc20ProgramId: string,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const [nameRaw, symbolRaw, decimalsRaw] = await Promise.all([
    callViewFunction(aleoClient, arc20ProgramId, 'name'),
    callViewFunction(aleoClient, arc20ProgramId, 'symbol'),
    callViewFunction(aleoClient, arc20ProgramId, 'decimals'),
  ]);
  const decimals = parseInt(decimalsRaw, 10);
  assert(
    !Number.isNaN(decimals),
    `Expected numeric decimals from ${arc20ProgramId}, got: ${decimalsRaw}`,
  );

  return {
    name: parseAleoIdentifier(nameRaw),
    symbol: parseAleoIdentifier(symbolRaw),
    decimals,
  };
}

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
  // Wrap the read + assert together so a mapping that hasn't finalized/indexed
  // yet (e.g. immediately after registration) is retried, not treated as absent.
  const mappingValue = await retryAsync(
    async () => {
      const value = await aleoClient.getProgramMappingValue(
        'token_registry.aleo',
        'registered_tokens',
        tokenId,
      );
      assert(
        value,
        `Expected token metadata to be registered in token_registry.aleo but none found for tokenId: ${tokenId}`,
      );
      return value;
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
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

  // Wrap the read + assert together so a mapping that hasn't finalized/indexed
  // yet (e.g. immediately after deployment) is retried, not treated as absent.
  const metadataValue = await retryAsync(
    async () => {
      const value = await aleoClient.getProgramMappingValue(
        programId,
        'app_metadata',
        'true',
      );
      assert(
        value,
        `Expected app_metadata mapping to exist for token ${tokenAddress} but none found`,
      );
      return value;
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
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

  // Wrap the read + assert together so a mapping that hasn't finalized/indexed
  // yet (e.g. immediately after deployment) is retried, not treated as absent.
  const metadataValue = await retryAsync(
    async () => {
      const value = await aleoClient.getProgramMappingValue(
        programId,
        'app_metadata',
        'true',
      );
      assert(
        value,
        `Expected app_metadata mapping to exist for token ${tokenAddress} but none found`,
      );
      return value;
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
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
 * Resolve token name/symbol/decimals for a warp token — ARC-20 for v2, token_registry for v1.
 */
async function resolveTokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  tokenId: string,
): Promise<{ name: string; symbol: string; decimals: number }> {
  if (isV2WarpToken(programId)) {
    const arc20ProgramId = await getArc20ProgramId(aleoClient, programId);
    return getArc20TokenMetadata(aleoClient, arc20ProgramId);
  }
  return getTokenMetadata(aleoClient, tokenId);
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
  const { programId } = fromAleoAddress(tokenAddress);

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

  // Get token ID and metadata — ARC-20 for v2, token_registry for v1
  const tokenId = metadata.token_id;
  assert(
    tokenId,
    `Expected token_id field in app_metadata for token ${tokenAddress} but none found`,
  );

  const { name, symbol, decimals } = await resolveTokenMetadata(
    aleoClient,
    programId,
    tokenId,
  );

  return {
    type: AleoTokenType.COLLATERAL,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    hook,
    remoteRouters,
    token: tokenId,
    name,
    symbol,
    decimals,
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
  const { programId } = fromAleoAddress(tokenAddress);

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

  // Get token metadata — ARC-20 for v2, token_registry for v1
  const tokenId = metadata.token_id;
  assert(
    tokenId,
    `Expected token_id field in app_metadata for token ${tokenAddress} but none found`,
  );

  const { name, symbol, decimals } = await resolveTokenMetadata(
    aleoClient,
    programId,
    tokenId,
  );

  return {
    type: AleoTokenType.SYNTHETIC,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    hook,
    remoteRouters,
    name,
    symbol,
    decimals,
  };
}
