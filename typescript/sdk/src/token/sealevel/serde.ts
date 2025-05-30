class MetadataData {
  name!: string;
  symbol!: string;
  uri!: string;
  sellerFeeBasisPoints!: number;
  creators?: string[];

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
    MetadataData,
    {
      kind: 'struct',
      fields: [
        ['name', 'string'],
        ['symbol', 'string'],
        ['uri', 'string'],
        ['sellerFeeBasisPoints', 'u16'],
        ['creators', { kind: 'option', type: ['string'] }],
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
