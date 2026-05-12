import {
  type AccountMeta,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getCompiledTransactionMessageEncoder,
  getShortU16Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { decodeSimulatedAccountMetas } from './codecs/simulated-account-meta.js';
import type { SvmRpc } from './types.js';

const ZERO_BLOCKHASH = blockhash('11111111111111111111111111111111');
const messageEncoder = getCompiledTransactionMessageEncoder();
const shortU16Encoder = getShortU16Encoder();

/**
 * Runs an instruction via `simulateTransaction(sigVerify=false,
 * replaceRecentBlockhash=true)` and returns the program's `set_return_data`
 * bytes. The RPC requires a complete versioned-tx envelope even though no
 * signatures are checked, so we wrap the instruction in a zero-blockhash v0
 * message and prepend the signer count + zero-filled signature slots.
 */
export async function simulateInstructionForReturnData(args: {
  rpc: SvmRpc;
  ix: Instruction;
  /** Funded address used as the simulation fee payer (signature not required). */
  payer: Address;
}): Promise<Uint8Array> {
  const base = createTransactionMessage({ version: 0 });
  const withPayer = setTransactionMessageFeePayer(args.payer, base);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: ZERO_BLOCKHASH, lastValidBlockHeight: 0n },
    withPayer,
  );
  const withIx = appendTransactionMessageInstructions([args.ix], withLifetime);
  const compiled = compileTransactionMessage(withIx);
  const messageBytes = messageEncoder.encode(compiled);

  const sigCountBytes = shortU16Encoder.encode(
    compiled.header.numSignerAccounts,
  );
  const sigsLen = compiled.header.numSignerAccounts * 64;
  const wireBytes = new Uint8Array(
    sigCountBytes.length + sigsLen + messageBytes.length,
  );
  wireBytes.set(sigCountBytes, 0);
  wireBytes.set(messageBytes, sigCountBytes.length + sigsLen);

  // CAST: branded type expects a signed wire tx but sigVerify=false accepts
  // the all-zero signature slots.
  const base64Tx = Buffer.from(wireBytes).toString(
    'base64',
  ) as Base64EncodedWireTransaction;

  const { value: result } = await args.rpc
    .simulateTransaction(base64Tx, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [] },
    })
    .send();

  if (result.err) {
    throw new Error(`simulation failed: ${JSON.stringify(result.err)}`);
  }
  const returnData = result.returnData?.data?.[0];
  assert(returnData, 'simulation returned no return_data');
  return Buffer.from(returnData, 'base64');
}

/**
 * Composes `simulateInstructionForReturnData` + `decodeSimulatedAccountMetas`:
 * runs a `GetXAccountMetas`-style instruction via simulation and returns the
 * decoded account-meta list as `@solana/kit`'s `AccountMeta[]` — directly
 * usable as instruction account inputs (after substituting any payer
 * placeholder at the documented slot).
 */
export async function simulateInstructionAccountMetas(args: {
  rpc: SvmRpc;
  ix: Instruction;
  payer: Address;
}): Promise<AccountMeta[]> {
  const returnData = await simulateInstructionForReturnData(args);
  return decodeSimulatedAccountMetas(returnData);
}
