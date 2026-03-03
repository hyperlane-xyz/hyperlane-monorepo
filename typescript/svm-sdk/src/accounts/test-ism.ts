import { decodeAccountData } from '../codecs/account-data.js';

export interface TestIsmStorage {
  accept: boolean;
}

export function decodeTestIsmStorageAccount(
  raw: Uint8Array,
): TestIsmStorage | null {
  const wrapped = decodeAccountData(raw, (cursor) => ({
    accept: cursor.readBool(),
  }));
  return wrapped.data;
}
