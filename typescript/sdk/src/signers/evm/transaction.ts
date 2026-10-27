import { Signer, Wallet, providers, utils } from 'ethers';
import { Wallet as ZkSyncWallet } from 'zksync-ethers';
import { TronWallet } from '@hyperlane-xyz/tron-sdk/runtime';
import {
  TransactionSubmission,
  type TransactionSubmissionOptions,
} from '@hyperlane-xyz/utils';

/** Submit without waiting for confirmation, exposing the actual broadcast boundary. */
export async function submitEvmLikeTransaction(
  signer: Signer,
  transaction: providers.TransactionRequest,
  options?: TransactionSubmissionOptions,
): Promise<providers.TransactionResponse> {
  const submission = new TransactionSubmission(options);
  return submission.run(async () => {
    if (signer instanceof TronWallet)
      return signer.sendTransaction(transaction, options ?? {});
    if (
      options &&
      signer instanceof Wallet &&
      !(signer instanceof ZkSyncWallet)
    ) {
      const populated = await signer.populateTransaction(transaction);
      const signed = await signer.signTransaction(populated);
      if (!signer.provider)
        throw new Error('Transaction signer has no provider');
      const provider = signer.provider;
      return submission.submit(
        () => provider.sendTransaction(signed),
        (tx) => tx.hash,
        utils.keccak256(signed),
      );
    }
    // Signers which combine preparation and broadcast cannot prove that a send
    // exception happened before broadcast. Preserve that uncertainty.
    return submission.submit(
      () => signer.sendTransaction(transaction),
      (tx) => tx.hash,
    );
  });
}
