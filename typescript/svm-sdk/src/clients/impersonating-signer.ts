import {
  type TransactionSigner,
  partiallySignTransactionMessageWithSigners,
} from '@solana/kit';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { type Logger, rootLogger } from '@hyperlane-xyz/utils';

import { FORK_IMPERSONATION_FEE_PAYER } from '../fork/impersonation.js';
import type { SvmReceipt, SvmRpc, SvmTransaction } from '../types.js';

import { BaseSvmSigner, type SignTransactionMessage } from './base-signer.js';

/**
 * A keyless impersonating signer for local Solana forks. It pays fees from a
 * fixed, public, fork-only account ({@link FORK_IMPERSONATION_FEE_PAYER}) that
 * signs its own fee-payer slot, while partial signing leaves every other
 * required-signer slot (e.g. the impersonated owner) empty. Those empty slots
 * are rejected by ordinary validators but accepted by a fork running with
 * skip-signature-verification — the Sealevel analog of impersonating an account
 * on an anvil fork. It holds no user key and never signs on behalf of the
 * accounts it impersonates, so it must only ever target a fork, never a live
 * cluster.
 */
export class SvmImpersonatingSigner
  extends BaseSvmSigner
  implements AltVM.IImpersonatingSigner<SvmTransaction, SvmReceipt>
{
  readonly impersonatesAccount = true;
  protected readonly logger: Logger = rootLogger.child({
    module: 'SvmImpersonatingSigner',
  });
  protected readonly signMessage: SignTransactionMessage =
    partiallySignTransactionMessageWithSigners;
  // Preflight simulation verifies signatures; the impersonated slots are
  // empty, so it would reject a transaction the fork itself accepts.
  protected readonly skipPreflight = true;

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    signer: TransactionSigner,
  ) {
    super(rpc, rpcUrls, chainMetadata, signer);
  }

  static async connect(
    metadata: ChainMetadataForAltVM,
  ): Promise<SvmImpersonatingSigner> {
    const { rpc, rpcUrls, keypair } = await BaseSvmSigner.resolveConnection(
      metadata,
      FORK_IMPERSONATION_FEE_PAYER.privateKey,
    );

    return new SvmImpersonatingSigner(rpc, rpcUrls, metadata, keypair);
  }
}
