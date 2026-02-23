import {
  type Address,
  type Option,
  type ReadonlyUint8Array,
  type Rpc,
  type SolanaRpcApi,
  fetchEncodedAccount,
  fixDecoderSize,
  getAddressDecoder,
  getBytesDecoder,
  getMapDecoder,
  getOptionDecoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU8Decoder,
  getU32Decoder,
  getU64Decoder,
  getUtf8Encoder,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import type {
  CollateralPlugin,
  NativePlugin,
  SyntheticPlugin,
} from '../generated/accounts/index.js';
import {
  getCollateralPluginDecoder,
  getNativePluginDecoder,
  getSyntheticPluginDecoder,
} from '../generated/accounts/index.js';
import type { InterchainGasPaymasterType } from '../generated/types/index.js';
import { getInterchainGasPaymasterTypeDecoder } from '../generated/types/index.js';

/**
 * Token type discriminants matching Rust token implementations.
 */
export enum SvmWarpTokenType {
  Synthetic = 'synthetic',
  Native = 'native',
  Collateral = 'collateral',
}

/**
 * Unwrapped HyperlaneToken for easier consumption.
 */
export type HyperlaneTokenData<T> = {
  bump: number;
  mailbox: Address;
  mailboxProcessAuthority: Address;
  dispatchAuthorityBump: number;
  decimals: number;
  remoteDecimals: number;
  owner: Address | null;
  interchainSecurityModule: Address | null;
  interchainGasPaymaster: readonly [Address, InterchainGasPaymasterType] | null;
  destinationGas: Map<number, bigint>;
  remoteRouters: Map<number, ReadonlyUint8Array>;
  pluginData: T;
};

/**
 * Unwraps Option<T> from @solana/kit decoder to T | null.
 */
function unwrapOption<T>(opt: Option<T>): T | null {
  if (typeof opt === 'object' && opt !== null && '__option' in opt) {
    return opt.__option === 'Some' ? opt.value : null;
  }
  return null;
}

/**
 * Unwraps decoded HyperlaneToken by converting Option types to null.
 */
function unwrapHyperlaneToken<T>(decoded: any): HyperlaneTokenData<T> {
  return {
    bump: decoded.bump,
    mailbox: decoded.mailbox,
    mailboxProcessAuthority: decoded.mailboxProcessAuthority,
    dispatchAuthorityBump: decoded.dispatchAuthorityBump,
    decimals: decoded.decimals,
    remoteDecimals: decoded.remoteDecimals,
    owner: unwrapOption(decoded.owner),
    interchainSecurityModule: unwrapOption(decoded.interchainSecurityModule),
    interchainGasPaymaster:
      decoded.interchainGasPaymaster?.__option === 'Some'
        ? [
            decoded.interchainGasPaymaster.value.programId,
            decoded.interchainGasPaymaster.value.accountType,
          ]
        : null,
    destinationGas: decoded.destinationGas,
    remoteRouters: decoded.remoteRouters,
    pluginData: decoded.pluginData as T,
  };
}

/**
 * Fetches raw account data and handles the AccountData<T> wrapper.
 *
 * Hyperlane Sealevel programs use an AccountData<T> wrapper that prepends
 * a 1-byte `initialized` flag before the actual data.
 */
async function fetchAccountDataWithInitFlag(
  rpc: Rpc<SolanaRpcApi>,
  address: Address,
): Promise<Uint8Array | null> {
  const maybeAccount = await fetchEncodedAccount(rpc, address);
  if (!maybeAccount.exists) {
    return null;
  }

  const data = maybeAccount.data;
  if (data.length === 0) {
    return null;
  }

  // First byte is the initialized flag
  const initialized = data[0] !== 0;
  if (!initialized) {
    return null;
  }

  // Return data after the initialized flag
  return data.slice(1);
}

/**
 * Gets the decoder for HyperlaneToken<T> where T is the plugin type.
 */
function getHyperlaneTokenDecoder<T>(pluginDecoder: any) {
  return getStructDecoder([
    ['bump', getU8Decoder()],
    ['mailbox', getAddressDecoder()],
    ['mailboxProcessAuthority', getAddressDecoder()],
    ['dispatchAuthorityBump', getU8Decoder()],
    ['decimals', getU8Decoder()],
    ['remoteDecimals', getU8Decoder()],
    ['owner', getOptionDecoder(getAddressDecoder())],
    ['interchainSecurityModule', getOptionDecoder(getAddressDecoder())],
    [
      'interchainGasPaymaster',
      getOptionDecoder(
        getStructDecoder([
          ['programId', getAddressDecoder()],
          ['accountType', getInterchainGasPaymasterTypeDecoder()],
        ]),
      ),
    ],
    ['destinationGas', getMapDecoder(getU32Decoder(), getU64Decoder())],
    [
      'remoteRouters',
      getMapDecoder(getU32Decoder(), fixDecoderSize(getBytesDecoder(), 32)),
    ],
    ['pluginData', pluginDecoder],
  ]);
}

/**
 * Derives the HyperlaneToken PDA address.
 * Seeds: ["hyperlane_message_recipient", "-", "handle", "-", "account_metas"]
 *
 * From Rust: hyperlane_token_pda_seeds!() macro
 * This doubles as the handle account metas PDA for the message recipient interface.
 */
export async function getHyperlaneTokenPda(
  programId: Address,
): Promise<readonly [Address, number]> {
  const utf8 = getUtf8Encoder();
  const pda = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      utf8.encode('hyperlane_message_recipient'),
      utf8.encode('-'),
      utf8.encode('handle'),
      utf8.encode('-'),
      utf8.encode('account_metas'),
    ],
  });
  return [pda[0], pda[1]];
}

/**
 * Fetches HyperlaneToken with SyntheticPlugin.
 */
export async function fetchSyntheticToken(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<HyperlaneTokenData<SyntheticPlugin> | null> {
  const [tokenPda] = await getHyperlaneTokenPda(programId);
  const rawData = await fetchAccountDataWithInitFlag(rpc, tokenPda);
  if (rawData === null) {
    return null;
  }
  const decoder = getHyperlaneTokenDecoder(getSyntheticPluginDecoder());
  const decoded = decoder.decode(rawData);
  return unwrapHyperlaneToken(decoded);
}

/**
 * Fetches HyperlaneToken with NativePlugin.
 */
export async function fetchNativeToken(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<HyperlaneTokenData<NativePlugin> | null> {
  const [tokenPda] = await getHyperlaneTokenPda(programId);
  console.log(`[fetchNativeToken] Program ID: ${programId}`);
  console.log(`[fetchNativeToken] Token PDA: ${tokenPda}`);

  const rawData = await fetchAccountDataWithInitFlag(rpc, tokenPda);
  console.log(
    `[fetchNativeToken] Raw data length: ${rawData?.length ?? 'null'}`,
  );

  if (rawData === null) {
    console.log(`[fetchNativeToken] No account data found at PDA ${tokenPda}`);
    return null;
  }
  const decoder = getHyperlaneTokenDecoder(getNativePluginDecoder());
  const decoded = decoder.decode(rawData);
  return unwrapHyperlaneToken(decoded);
}

/**
 * Fetches HyperlaneToken with CollateralPlugin.
 */
export async function fetchCollateralToken(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<HyperlaneTokenData<CollateralPlugin> | null> {
  const [tokenPda] = await getHyperlaneTokenPda(programId);
  const rawData = await fetchAccountDataWithInitFlag(rpc, tokenPda);
  if (rawData === null) {
    return null;
  }
  const decoder = getHyperlaneTokenDecoder(getCollateralPluginDecoder());
  const decoded = decoder.decode(rawData);
  return unwrapHyperlaneToken(decoded);
}

/**
 * Detects warp token type by attempting to deserialize with each plugin decoder.
 * Returns the first successful parse.
 */
export async function detectWarpTokenType(
  rpc: Rpc<SolanaRpcApi>,
  programId: Address,
): Promise<SvmWarpTokenType> {
  const [tokenPda] = await getHyperlaneTokenPda(programId);
  const rawData = await fetchAccountDataWithInitFlag(rpc, tokenPda);
  assert(rawData !== null, `Token account not initialized at ${programId}`);

  // Try synthetic first (most common)
  try {
    const syntheticDecoder = getHyperlaneTokenDecoder(
      getSyntheticPluginDecoder(),
    );
    syntheticDecoder.decode(rawData);
    return SvmWarpTokenType.Synthetic;
  } catch {
    // Not synthetic, continue
  }

  // Try native
  try {
    const nativeDecoder = getHyperlaneTokenDecoder(getNativePluginDecoder());
    nativeDecoder.decode(rawData);
    return SvmWarpTokenType.Native;
  } catch {
    // Not native, continue
  }

  // Try collateral
  try {
    const collateralDecoder = getHyperlaneTokenDecoder(
      getCollateralPluginDecoder(),
    );
    collateralDecoder.decode(rawData);
    return SvmWarpTokenType.Collateral;
  } catch {
    // Not collateral either
  }

  throw new Error(`Unable to detect warp token type for program: ${programId}`);
}

/**
 * Converts remote router bytes (32-byte H256) to hex string.
 */
export function routerBytesToHex(router: ReadonlyUint8Array): string {
  return '0x' + Buffer.from(router).toString('hex');
}

/**
 * Converts hex router address to 32-byte Uint8Array.
 */
export function routerHexToBytes(router: string): Uint8Array {
  const hex = router.startsWith('0x') ? router.slice(2) : router;
  assert(
    hex.length === 64,
    `Router address must be 32 bytes (64 hex chars), got ${hex.length}`,
  );
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Derives the native collateral PDA for native tokens.
 * Seeds: ["hyperlane_token", "-", "native_collateral"]
 */
export async function getNativeCollateralPda(
  programId: Address,
): Promise<readonly [Address, number]> {
  const utf8 = getUtf8Encoder();
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      utf8.encode('hyperlane_token'),
      utf8.encode('-'),
      utf8.encode('native_collateral'),
    ],
  });
}

/**
 * Derives the dispatch authority PDA.
 * Seeds: ["hyperlane_dispatcher", "-", "dispatch_authority"]
 * Derived from the token program (not mailbox).
 */
export async function getDispatchAuthorityPda(
  tokenProgramId: Address,
): Promise<readonly [Address, number]> {
  const utf8 = getUtf8Encoder();
  return getProgramDerivedAddress({
    programAddress: tokenProgramId,
    seeds: [
      utf8.encode('hyperlane_dispatcher'),
      utf8.encode('-'),
      utf8.encode('dispatch_authority'),
    ],
  });
}
