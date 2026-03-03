import { type Address, getAddressDecoder } from '@solana/kit';

import { decodeAccountData } from '../codecs/account-data.js';
import { ByteCursor } from '../codecs/binary.js';
import {
  decodeDomainedValidatorsAndThreshold,
  decodeValidatorsAndThreshold,
  type Domained,
  type ValidatorsAndThreshold,
} from '../codecs/shared.js';

export interface AccessControlData {
  bumpSeed: number;
  owner: Address | null;
}

export interface DomainData {
  bumpSeed: number;
  validatorsAndThreshold: ValidatorsAndThreshold;
}

// Could be migrated to struct codecs; left manual here to keep parity with adjacent account decoders.
const addressDecoder = getAddressDecoder();

export function decodeMultisigIsmAccessControlAccount(
  raw: Uint8Array,
): AccessControlData | null {
  const wrapped = decodeAccountData(raw, (cursor) => {
    const bumpSeed = cursor.readU8();
    const hasOwner = cursor.readU8() === 1;
    const owner = hasOwner ? addressDecoder.decode(cursor.readBytes(32)) : null;
    return { bumpSeed, owner };
  });
  return wrapped.data;
}

export function decodeMultisigIsmDomainDataAccount(
  raw: Uint8Array,
): DomainData | null {
  const wrapped = decodeAccountData(raw, (cursor) => {
    const bumpSeed = cursor.readU8();
    const validatorsAndThreshold = decodeValidatorsAndThreshold(cursor);
    return {
      bumpSeed,
      validatorsAndThreshold,
    };
  });
  return wrapped.data;
}

export function decodeSetValidatorsAndThresholdPayload(
  payload: Uint8Array,
): Domained<ValidatorsAndThreshold> {
  return decodeDomainedValidatorsAndThreshold(new ByteCursor(payload));
}
