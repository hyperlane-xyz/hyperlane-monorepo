import { Plaintext } from '@provablehq/sdk';

import {
  assert,
  isNullish,
  isZeroishAddress,
  retryAsync,
  rootLogger,
} from '@hyperlane-xyz/utils';

import type { AnyAleoNetworkClient } from '../clients/base.js';
import {
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  U128ToString,
  fromAleoAddress,
  isV2WarpToken,
} from '../utils/helper.js';
import { toAleoAddress } from '../utils/helper.crypto.js';
import {
  type AleoCollateralWarpTokenConfig,
  type AleoNativeWarpTokenConfig,
  type AleoSyntheticWarpTokenConfig,
  AleoTokenType,
} from '../utils/types.js';
import * as providerQuery from './provider-query.js';

const logger = rootLogger.child({ module: 'aleo-warp-query' });

export {
  callViewFunction,
  getArc20ProgramId,
  getArc20TokenMetadata,
  parseAleoUint,
  parseViewFunctionOutputs,
} from './provider-query.js';

/**
 * Converts the v2 ARC-20 warp token standard's on-chain local_decimals/
 * remote_decimals fields into the scale multiplier convention used elsewhere
 * in the SDK (mirrors svm-sdk's remoteDecimalsToScale). Returns undefined for
 * identity scale (remote === local) or when either side is unavailable.
 */
export function localRemoteDecimalsToScale(
  localDecimals: number | undefined,
  remoteDecimals: number | undefined,
): number | undefined {
  if (isNullish(localDecimals) || isNullish(remoteDecimals)) return undefined;
  const diff = remoteDecimals - localDecimals;
  return diff === 0 ? undefined : Math.pow(10, diff);
}

/**
 * Converts hyp_native's on-chain `scale` field — a base-10 exponent (see
 * `pow 10u64 r0.scale` in the hyp_native program) — into the SDK's scale
 * multiplier convention used elsewhere (undefined for identity, i.e.
 * exponent 0).
 */
export function nativeScaleExponentToMultiplier(
  exponent: number | undefined,
): number | undefined {
  if (isNullish(exponent) || exponent === 0) return undefined;
  return Math.pow(10, exponent);
}

/**
 * Thrown when a `registered_tokens` read for a tokenId yields no value — either
 * the token was never registered (legacy v1 synthetics) or it was just
 * registered and has not finalized/indexed yet. Both cases look identical at
 * read time, so this stays recoverable: retryAsync retries it, and only after
 * the retries are exhausted does resolveTokenMetadata treat it as a genuine
 * miss and fall back. Any other error (RPC/transport, plaintext decode) is a
 * distinct failure that must propagate.
 */
export class TokenRegistryEntryNotFoundError extends Error {
  constructor(tokenId: string) {
    super(
      `Expected token metadata to be registered in token_registry.aleo but none found for tokenId: ${tokenId}`,
    );
    this.name = 'TokenRegistryEntryNotFoundError';
  }
}

/**
 * Query token metadata from token_registry.aleo
 */
export async function getTokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  tokenId: string,
  retryAttempts: number = RETRY_ATTEMPTS,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<{
  name: string;
  symbol: string;
  decimals: number;
}> {
  // An empty read may be a genuine legacy miss or a just-registered mapping
  // that has not finalized/indexed yet, so retry the bounded budget before
  // giving up. After exhaustion retryAsync rethrows TokenRegistryEntryNotFound-
  // Error, which resolveTokenMetadata catches to fall back; transient RPC/
  // transport errors surface as plain (recoverable) errors and are retried too.
  const mappingValue = await retryAsync(
    async () => {
      const value = await aleoClient.getProgramMappingValue(
        'token_registry.aleo',
        'registered_tokens',
        tokenId,
      );
      if (isNullish(value) || value === '') {
        throw new TokenRegistryEntryNotFoundError(tokenId);
      }
      return value;
    },
    retryAttempts,
    retryDelayMs,
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
  return providerQuery.getRemoteRouters(
    { Plaintext },
    aleoClient,
    tokenAddress,
  );
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
  // Present on collateral/synthetic tokens regardless of v1 vs v2 (verified
  // live on-chain for a v1 synthetic token) -- getWarpTokenMetadata reads the
  // same app_metadata mapping either way, so no version branching is needed
  // here. Native tokens use a different Metadata struct (a single `scale`
  // field, not a local/remote decimals pair) and never have these.
  local_decimals?: number;
  remote_decimals?: number;
  // Native-only: base-10 exponent (see nativeScaleExponentToMultiplier).
  // Collateral/synthetic tokens never have this field.
  scale?: number;
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
  const localDecimals = metadata['local_decimals'];
  const remoteDecimals = metadata['remote_decimals'];
  const scale = metadata['scale'];

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
  assert(
    isNullish(localDecimals) || typeof localDecimals === 'number',
    `Expected local_decimals field to be a number in app_metadata for token ${tokenAddress} but got ${typeof localDecimals}`,
  );
  assert(
    isNullish(remoteDecimals) || typeof remoteDecimals === 'number',
    `Expected remote_decimals field to be a number in app_metadata for token ${tokenAddress} but got ${typeof remoteDecimals}`,
  );
  assert(
    isNullish(scale) || typeof scale === 'number',
    `Expected scale field to be a number in app_metadata for token ${tokenAddress} but got ${typeof scale}`,
  );

  return {
    token_type: tokenType,
    token_owner: tokenOwner,
    ism,
    hook,
    token_id: tokenId,
    local_decimals: localDecimals,
    remote_decimals: remoteDecimals,
    scale,
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

  const scale = nativeScaleExponentToMultiplier(metadata.scale);

  return {
    type: AleoTokenType.NATIVE,
    owner: metadata.token_owner,
    mailbox: mailboxAddress,
    ism,
    hook,
    remoteRouters,
    scale,
  };
}

/**
 * Resolve token name/symbol/decimals for a warp token — ARC-20 for v2, token_registry for v1.
 *
 * name/symbol/decimals live in the ARC-20 token program (v2) or token_registry.aleo (v1).
 * v1 tokens that were never registered in token_registry.aleo (e.g. legacy synthetics) make
 * that lookup throw after its bounded retries are exhausted, but decimals are also carried
 * authoritatively in app_metadata.local_decimals and name/symbol are not compared by
 * check-warp-deploy, so a registry miss is non-fatal: fall back to local_decimals for decimals
 * and empty strings for name/symbol.
 */
export async function resolveTokenMetadata(
  aleoClient: AnyAleoNetworkClient,
  programId: string,
  tokenId: string,
  localDecimals: number | undefined,
  retryAttempts: number = RETRY_ATTEMPTS,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<{ name: string; symbol: string; decimals: number }> {
  // v2 ARC-20 tokens carry authoritative name/symbol/decimals in their token
  // program; any failure reading it is a real error and must propagate.
  if (isV2WarpToken(programId)) {
    const arc20ProgramId = await providerQuery.getArc20ProgramId(
      aleoClient,
      programId,
    );
    return providerQuery.getArc20TokenMetadata(aleoClient, arc20ProgramId);
  }

  // v1 tokens read name/symbol/decimals from token_registry.aleo. Legacy
  // synthetics were never registered there, so a registry miss that persists
  // across the bounded retries is non-fatal (decimals are also in
  // app_metadata.local_decimals; name/symbol aren't compared by
  // check-warp-deploy). Any OTHER failure — RPC/transport, plaintext decode —
  // is a real error and must propagate.
  let registryMetadata:
    | { name: string; symbol: string; decimals: number }
    | undefined;
  try {
    registryMetadata = await getTokenMetadata(
      aleoClient,
      tokenId,
      retryAttempts,
      retryDelayMs,
    );
  } catch (error: unknown) {
    if (!(error instanceof TokenRegistryEntryNotFoundError)) {
      throw error;
    }
    logger.warn(
      { programId, tokenId, err: error },
      'token_registry.aleo has no entry for this v1 token; falling back to app_metadata.local_decimals for decimals and empty name/symbol',
    );
  }

  const decimals = registryMetadata?.decimals ?? localDecimals;
  assert(
    decimals != null,
    `Unable to resolve decimals for token ${programId} (tokenId ${tokenId}): token registry lookup failed and app_metadata.local_decimals is missing`,
  );

  return {
    name: registryMetadata?.name ?? '',
    symbol: registryMetadata?.symbol ?? '',
    decimals,
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
    metadata.local_decimals,
  );

  const scale = localRemoteDecimalsToScale(
    metadata.local_decimals,
    metadata.remote_decimals,
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
    scale,
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
    metadata.local_decimals,
  );

  const scale = localRemoteDecimalsToScale(
    metadata.local_decimals,
    metadata.remote_decimals,
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
    scale,
  };
}
