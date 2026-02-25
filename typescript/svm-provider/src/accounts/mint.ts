import {
  address as parseAddress,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';

import { ByteCursor } from '../codecs/binary.js';
import {
  METAPLEX_METADATA_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../constants.js';
import type { SvmRpc } from '../types.js';

/**
 * SPL Token / Token 2022 mint layout (first 82 bytes are identical):
 *   mintAuthorityOption(4) + mintAuthority(32) + supply(8) + decimals(1) + ...
 *   -> decimals is at byte 44.
 */
const MINT_DECIMALS_OFFSET = 44;

/**
 * Token 2022 mints are padded to ACCOUNT_SIZE (165 bytes) to share the same
 * AccountType offset as token accounts. Layout:
 *   baseMint(82) + padding(83) + AccountType(1) + extensions...
 *   → AccountType at byte 165, extensions start at byte 166.
 */
const ACCOUNT_SIZE = 165;
const EXTENSIONS_OFFSET = ACCOUNT_SIZE + 1; // 166

const METADATA_POINTER_EXTENSION_TYPE = 18;
const TOKEN_METADATA_EXTENSION_TYPE = 19;

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();
const utf8Encoder = getUtf8Encoder();

export function getMintDecimals(data: Uint8Array): number {
  return data[MINT_DECIMALS_OFFSET]!;
}

/**
 * Parses Token 2022 TLV extension blocks into a Map<extensionType, data>.
 */
export function parseToken2022Extensions(
  data: Uint8Array,
): Map<number, Uint8Array> {
  const extensions = new Map<number, Uint8Array>();
  if (data.length <= EXTENSIONS_OFFSET) return extensions;

  const view = new DataView(data.buffer, data.byteOffset);
  let offset = EXTENSIONS_OFFSET;

  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    offset += 4;
    if (type === 0) break; // end sentinel
    extensions.set(type, data.slice(offset, offset + length));
    offset += length;
  }

  return extensions;
}

/**
 * Decodes the MetadataPointer extension data (64 bytes):
 *   authority(32) + metadataAddress(32)
 * An all-zero pubkey means None.
 */
export function decodeMetadataPointerAddress(
  extData: Uint8Array,
): string | null {
  if (extData.length < 64) return null;
  const metadataAddressBytes = extData.slice(32, 64);
  if (metadataAddressBytes.every((b) => b === 0)) return null;
  return addressDecoder.decode(metadataAddressBytes);
}

/**
 * Decodes the TokenMetadata extension / standalone account data.
 * The spl-token-metadata-interface stores without discriminator:
 *   updateAuthority(32) + mint(32) + name(Borsh str) + symbol(Borsh str) + ...
 */
export function decodeTokenMetadataFields(
  data: Uint8Array,
): { name: string; symbol: string; uri: string } | null {
  try {
    // Skip updateAuthority(32) + mint(32) = 64 bytes.
    const cursor = new ByteCursor(data.slice(64));
    const name = cursor.readString().trim();
    const symbol = cursor.readString().trim();
    const uri = cursor.readString().trim();
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/**
 * Decodes name/symbol/uri from a Metaplex metadata account.
 * Layout: key(1) + updateAuthority(32) + mint(32), then Borsh strings.
 */
export function decodeMetaplexMetadata(data: Uint8Array): {
  name: string;
  symbol: string;
  uri: string;
} {
  let offset = 65; // skip key(1) + updateAuthority(32) + mint(32)
  const view = new DataView(data.buffer, data.byteOffset);

  function readString(): string {
    const len = view.getUint32(offset, true);
    offset += 4;
    const bytes = data.subarray(offset, offset + len);
    offset += len;
    return new TextDecoder().decode(bytes).replace(/\0/g, '').trim();
  }

  return { name: readString(), symbol: readString(), uri: readString() };
}

/**
 * Fetches the name, symbol, and decimals for any SPL Token or Token 2022 mint.
 * Tries Token 2022 inline/external metadata first, then Metaplex, then falls
 * back to 'Unknown Token' / 'UNKNOWN' if no metadata is found.
 */
export async function fetchMintMetadata(
  rpc: SvmRpc,
  mintAddress: string,
): Promise<{ name: string; symbol: string; decimals: number; uri?: string }> {
  const account = await fetchEncodedAccount(rpc, parseAddress(mintAddress));
  if (!account.exists)
    throw new Error(`Mint account not found: ${mintAddress}`);

  const data = account.data as Uint8Array;
  const decimals = getMintDecimals(data);
  const isToken2022 = account.programAddress === TOKEN_2022_PROGRAM_ADDRESS;

  // Try Token 2022 inline or external metadata.
  if (isToken2022 && data.length > EXTENSIONS_OFFSET) {
    const extensions = parseToken2022Extensions(data);
    const metadataPtrExt = extensions.get(METADATA_POINTER_EXTENSION_TYPE);
    if (metadataPtrExt) {
      const metadataAddress = decodeMetadataPointerAddress(metadataPtrExt);
      if (metadataAddress) {
        // Metadata stored inline as a TokenMetadata extension.
        const tokenMetaExt = extensions.get(TOKEN_METADATA_EXTENSION_TYPE);
        if (tokenMetaExt) {
          const meta = decodeTokenMetadataFields(tokenMetaExt);
          if (meta?.name && meta?.symbol) return { ...meta, decimals };
        }

        // Metadata stored in a separate account.
        if (metadataAddress !== mintAddress) {
          const metaAccount = await fetchEncodedAccount(
            rpc,
            parseAddress(metadataAddress),
          );
          if (metaAccount.exists) {
            const meta = decodeTokenMetadataFields(
              metaAccount.data as Uint8Array,
            );
            if (meta?.name && meta?.symbol) return { ...meta, decimals };
          }
        }
      }
    }
  }

  // Try Metaplex metadata.
  try {
    const [metadataPDA] = await getProgramDerivedAddress({
      programAddress: parseAddress(METAPLEX_METADATA_PROGRAM_ADDRESS),
      seeds: [
        utf8Encoder.encode('metadata'),
        addressEncoder.encode(parseAddress(METAPLEX_METADATA_PROGRAM_ADDRESS)),
        addressEncoder.encode(parseAddress(mintAddress)),
      ],
    });
    const metaAccount = await fetchEncodedAccount(rpc, metadataPDA);
    if (metaAccount.exists) {
      const { name, symbol, uri } = decodeMetaplexMetadata(
        metaAccount.data as Uint8Array,
      );
      if (name && symbol) return { name, symbol, decimals, uri };
    }
  } catch {
    // Fall through to unknown.
  }

  return { name: 'Unknown Token', symbol: 'UNKNOWN', decimals };
}
