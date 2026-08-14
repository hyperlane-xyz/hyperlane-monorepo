import {
  type Address,
  type TransactionSigner,
  address as parseAddress,
  partiallySignTransactionMessageWithSigners,
} from '@solana/kit';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import {
  assert,
  eqAddressSol,
  isNullish,
  type Logger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { FORK_IMPERSONATION_FEE_PAYER } from '../fork/impersonation.js';
import type { SvmReceipt, SvmRpc, SvmTransaction } from '../types.js';

import { BaseSvmSigner, type SignTransactionMessage } from './base-signer.js';

/**
 * A keyless impersonating signer for local Solana forks: it pays fees from a
 * fixed public fork-only account ({@link FORK_IMPERSONATION_FEE_PAYER}) and
 * leaves the impersonated account's required-signer slot empty, which only a
 * fork running with skip-signature-verification accepts — so it must only ever
 * target a fork. Impersonation is scoped to the configured account via
 * {@link assertUnsignedSlotsAreImpersonated}.
 */
export class SvmImpersonatingSigner
  extends BaseSvmSigner
  implements AltVM.IImpersonatingSigner<SvmTransaction, SvmReceipt>
{
  readonly impersonatesAccount = true;
  protected readonly logger: Logger = rootLogger.child({
    module: 'SvmImpersonatingSigner',
  });
  protected readonly signMessage: SignTransactionMessage = async (message) => {
    const transaction =
      await partiallySignTransactionMessageWithSigners(message);
    assertUnsignedSlotsAreImpersonated(transaction, this.userAddress);
    return transaction;
  };
  // Preflight simulation verifies signatures; the impersonated slots are
  // empty, so it would reject a transaction the fork itself accepts.
  protected readonly skipPreflight = true;

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    signer: TransactionSigner,
    private readonly userAddress: Address,
  ) {
    super(rpc, rpcUrls, chainMetadata, signer);
  }

  static async create(
    metadata: ChainMetadataForAltVM,
    userAddress: string,
  ): Promise<SvmImpersonatingSigner> {
    const { rpc, rpcUrls, keypair } = await BaseSvmSigner.resolveConnection(
      metadata,
      FORK_IMPERSONATION_FEE_PAYER.privateKey,
    );

    return new SvmImpersonatingSigner(
      rpc,
      rpcUrls,
      metadata,
      keypair,
      parseAddress(userAddress),
    );
  }
}

type SvmSignedTransaction = Awaited<ReturnType<SignTransactionMessage>>;

/**
 * Asserts every required-signer slot partial signing left unfilled (signature
 * nullish or all-zero) belongs to the impersonated account, so the empty slots
 * a fork accepts can't let a transaction needing a different authority's
 * signature land silently.
 */
function assertUnsignedSlotsAreImpersonated(
  transaction: SvmSignedTransaction,
  userAddress: Address,
): void {
  for (const [signerAddress, signature] of Object.entries(
    transaction.signatures,
  )) {
    const signed =
      !isNullish(signature) && signature.some((byte) => byte !== 0);
    if (signed) {
      continue;
    }
    assert(
      eqAddressSol(signerAddress, userAddress),
      `Impersonated submitter is configured to impersonate ${userAddress}, but the transaction leaves a required signature unfilled for ${signerAddress}`,
    );
  }
}
