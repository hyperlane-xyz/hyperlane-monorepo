import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

/**
 * Compose a Sealevel transaction from a flat ordered ix list. Mirrors the
 * compilation logic in `SealevelHypTokenAdapter.populateTransferRemoteTx`
 * but accepts an arbitrary ix sequence — used by
 * `SealevelQuotedTransferProvider` to splice `SubmitFeeQuote` /
 * `SubmitIgpQuote` ixs between the compute-budget head and the warp
 * transfer ix.
 *
 *  - When `addressLookupTableAccounts` is non-empty, emits a v0
 *    `VersionedTransaction` (ALTs keep the account-key list under Solana's
 *    1232-byte tx limit on 40+ account warp routes).
 *  - Otherwise, emits a legacy `Transaction`.
 *
 * `signers` are partial-signed at compose time (typical use case is the
 * adapter's randomWallet for the dispatched-message PDA). The user wallet
 * signs after this returns, via the caller's wallet adapter.
 */
export async function composeSealevelTx(args: {
  connection: Connection;
  instructions: TransactionInstruction[];
  addressLookupTableAccounts: AddressLookupTableAccount[];
  feePayer: PublicKey;
  signers?: Keypair[];
}): Promise<Transaction | VersionedTransaction> {
  const recentBlockhash = (
    await args.connection.getLatestBlockhash('finalized')
  ).blockhash;
  const signers = args.signers ?? [];

  if (args.addressLookupTableAccounts.length > 0) {
    const message = MessageV0.compile({
      payerKey: args.feePayer,
      instructions: args.instructions,
      recentBlockhash,
      addressLookupTableAccounts: args.addressLookupTableAccounts,
    });
    const versionedTx = new VersionedTransaction(message);
    if (signers.length > 0) {
      versionedTx.sign(signers);
    }
    return versionedTx;
  }

  // @ts-expect-error Workaround for bug in the web3 lib, sometimes uses recentBlockhash and sometimes uses blockhash
  const tx = new Transaction({
    feePayer: args.feePayer,
    blockhash: recentBlockhash,
    recentBlockhash,
  });
  for (const ix of args.instructions) tx.add(ix);
  for (const signer of signers) tx.partialSign(signer);
  return tx;
}
