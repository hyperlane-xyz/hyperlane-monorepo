import {
  AccountRole,
  upgradeRoleToSigner,
  upgradeRoleToWritable,
  type AccountMeta,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { readAddress } from './account-data.js';
import { ByteCursor } from './binary.js';

/** Wire bytes per entry: 32 pubkey + 1 isSigner + 1 isWritable. */
const META_ENTRY_BYTES = 34;

/**
 * Decodes the wire format emitted by Solana programs that return
 * `SimulationReturnData<Vec<SerializableAccountMeta>>` from `set_return_data`
 * during simulation:
 *
 *   u32le length || N × (32 pubkey || bool isSigner || bool isWritable) || u8 trailing
 *
 * The trailing byte is the `serializable-account-meta` crate's workaround for
 * Solana truncating trailing zero bytes from return-data. We translate the
 * two-boolean wire shape directly into `@solana/kit`'s `AccountMeta` —
 * callers can pass the result into instruction account arrays without an
 * intermediate `{ pubkey, isSigner, isWritable } → { address, role }` map.
 */
export function decodeSimulatedAccountMetas(raw: Uint8Array): AccountMeta[] {
  const cursor = new ByteCursor(raw);
  const count = cursor.readU32LE();
  // Bound `count` against the remaining buffer so a malformed RPC response
  // can't trick us into a huge allocation that only fails on buffer
  // underflow several iterations in.
  assert(
    count <= cursor.remaining() / META_ENTRY_BYTES,
    `decodeSimulatedAccountMetas: count ${count} exceeds remaining buffer (${cursor.remaining()} bytes)`,
  );
  const metas: AccountMeta[] = [];
  for (let i = 0; i < count; i += 1) {
    const address = readAddress(cursor);
    const isSigner = cursor.readBool();
    const isWritable = cursor.readBool();
    metas.push({ address, role: toAccountRole(isSigner, isWritable) });
  }
  return metas;
}

function toAccountRole(isSigner: boolean, isWritable: boolean): AccountRole {
  let role: AccountRole = AccountRole.READONLY;
  if (isWritable) role = upgradeRoleToWritable(role);
  if (isSigner) role = upgradeRoleToSigner(role);
  return role;
}
