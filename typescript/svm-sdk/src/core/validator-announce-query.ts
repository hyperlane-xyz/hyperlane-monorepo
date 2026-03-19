import { getAddressCodec, type Address } from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { ByteCursor } from '../codecs/binary.js';
import { decodeAccountData } from '../codecs/account-data.js';
import {
  deriveValidatorAnnouncePda,
  deriveValidatorStorageLocationsPda,
} from '../pda.js';
import { fetchAccountDataRaw } from '../rpc.js';
import type { SvmRpc } from '../types.js';

const ADDRESS_CODEC = getAddressCodec();

export interface ValidatorAnnounceAccountData {
  bumpSeed: number;
  mailbox: Address;
  localDomain: number;
}

export interface ValidatorStorageLocationsData {
  bumpSeed: number;
  storageLocations: string[];
}

export function decodeValidatorAnnounceAccount(
  raw: Uint8Array,
): ValidatorAnnounceAccountData | null {
  const { data } = decodeAccountData(raw, (cursor: ByteCursor) => ({
    bumpSeed: cursor.readU8(),
    mailbox: cursor.readWithDecoder(ADDRESS_CODEC),
    localDomain: cursor.readU32LE(),
  }));
  return data;
}

export function decodeValidatorStorageLocationsAccount(
  raw: Uint8Array,
): ValidatorStorageLocationsData | null {
  const { data } = decodeAccountData(raw, (cursor: ByteCursor) => {
    const bumpSeed = cursor.readU8();
    const count = cursor.readU32LE();
    const storageLocations: string[] = [];
    for (let i = 0; i < count; i++) {
      storageLocations.push(cursor.readString());
    }
    return { bumpSeed, storageLocations };
  });
  return data;
}

export async function fetchValidatorAnnounceAccount(
  rpc: SvmRpc,
  programId: Address,
): Promise<ValidatorAnnounceAccountData | null> {
  const { address: announcePda } = await deriveValidatorAnnouncePda(programId);
  const raw = await fetchAccountDataRaw(rpc, announcePda);
  if (!raw) return null;
  return decodeValidatorAnnounceAccount(raw);
}

export async function fetchValidatorStorageLocations(
  rpc: SvmRpc,
  programId: Address,
  validatorH160: Uint8Array,
): Promise<ValidatorStorageLocationsData | null> {
  assert(
    validatorH160.length === 20,
    `Validator address must be 20 bytes (H160), got ${validatorH160.length}`,
  );
  const { address: storageLocationsPda } =
    await deriveValidatorStorageLocationsPda(programId, validatorH160);
  const raw = await fetchAccountDataRaw(rpc, storageLocationsPda);
  if (!raw) return null;
  return decodeValidatorStorageLocationsAccount(raw);
}
