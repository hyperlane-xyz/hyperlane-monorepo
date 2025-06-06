import { Connection, PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import { assert } from '@hyperlane-xyz/utils';

import { SealevelAccountDataWrapper } from '../../utils/sealevelSerialization.js';
import {
  SealevelHyperlaneTokenData,
  SealevelHyperlaneTokenDataSchema,
} from '../adapters/serialization.js';

import { Metadata, SPL_TOKEN_METADATA_SCHEMA } from './serde.js';

export async function getSealevelHypTokenAccountData(
  svmProvider: Readonly<Connection>,
  tokenMetaPda: PublicKey,
): Promise<SealevelHyperlaneTokenData> {
  const accountInfo = await svmProvider.getAccountInfo(tokenMetaPda);

  assert(
    !!accountInfo,
    `No account info found for token at address "${tokenMetaPda.toBase58()}"`,
  );

  const { data } = deserializeUnchecked<
    SealevelAccountDataWrapper<SealevelHyperlaneTokenData>
  >(
    SealevelHyperlaneTokenDataSchema,
    SealevelAccountDataWrapper,
    accountInfo.data,
  );

  return data;
}

const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

const removeNullPaddingFromString = (s: string) => s.replaceAll('\x00', '');

export async function getLegacySPLTokenMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<{ name: string; symbol: string; uri: string } | null> {
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
