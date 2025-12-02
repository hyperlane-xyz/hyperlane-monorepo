import { Connection, PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

class Creator {
  address!: Uint8Array;
  verified!: number;
  share!: number;

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

class MetadataData {
  name!: string;
  symbol!: string;
  uri!: string;
  sellerFeeBasisPoints!: number;
  creators?: Creator[];

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export class Metadata {
  key!: number;
  updateAuthority!: Uint8Array;
  mint!: Uint8Array;
  data!: MetadataData;
  primarySaleHappened!: number;
  isMutable!: number;
  editionNonce?: number;

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SPL_TOKEN_METADATA_SCHEMA = new Map<any, any>([
  [
    Creator,
    {
      kind: 'struct',
      fields: [
        ['address', [32]],
        ['verified', 'u8'],
        ['share', 'u8'],
      ],
    },
  ],
  [
    MetadataData,
    {
      kind: 'struct',
      fields: [
        ['name', 'string'],
        ['symbol', 'string'],
        ['uri', 'string'],
        ['sellerFeeBasisPoints', 'u16'],
        ['creators', { kind: 'option', type: [Creator] }],
      ],
    },
  ],
  [
    Metadata,
    {
      kind: 'struct',
      fields: [
        ['key', 'u8'],
        ['updateAuthority', [32]],
        ['mint', [32]],
        ['data', MetadataData],
        ['primarySaleHappened', 'u8'],
        ['isMutable', 'u8'],
        ['editionNonce', { kind: 'option', type: 'u8' }],
      ],
    },
  ],
]);

// Metadata program account for creating SPL tokens metadata
const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

const removeNullPaddingFromString = (s: string) => s.replaceAll('\x00', '');

export async function getLegacySPLTokenMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<{ name: string; symbol: string; uri: string } | null> {
  // Derive the SPL token metadata account
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  );

  const accountInfo = await connection.getAccountInfo(metadataPda);
  if (!accountInfo) return null;

  const metadata = deserializeUnchecked(
    SPL_TOKEN_METADATA_SCHEMA,
    Metadata,
    accountInfo.data,
  );

  return {
    name: removeNullPaddingFromString(metadata.data.name),
    symbol: removeNullPaddingFromString(metadata.data.symbol),
    uri: removeNullPaddingFromString(metadata.data.uri),
  };
}
