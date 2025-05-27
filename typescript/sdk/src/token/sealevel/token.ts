import { Connection, PublicKey } from '@solana/web3.js';
import { deserializeUnchecked } from 'borsh';

import { assert } from '@hyperlane-xyz/utils';

import { SealevelAccountDataWrapper } from '../../utils/sealevelSerialization.js';
import {
  SealevelHyperlaneTokenData,
  SealevelHyperlaneTokenDataSchema,
} from '../adapters/serialization.js';

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
