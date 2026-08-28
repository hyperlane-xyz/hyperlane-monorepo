import {
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, type Logger, rootLogger } from '@hyperlane-xyz/utils';

import type { SvmRpc } from '../types.js';

import { BaseSvmSigner, type SignTransactionMessage } from './base-signer.js';

type TransactionSigningSigner =
  | TransactionModifyingSigner
  | TransactionPartialSigner;

export class SvmSigner extends BaseSvmSigner {
  protected readonly logger: Logger = rootLogger.child({ module: 'SvmSigner' });
  protected readonly signMessage: SignTransactionMessage =
    signTransactionMessageWithSigners;

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    signer: TransactionSigningSigner,
  ) {
    super(rpc, rpcUrls, chainMetadata, signer);
  }

  static async connectWithSigner(
    metadata: ChainMetadataForAltVM,
    signer: string | TransactionSigningSigner,
  ): Promise<SvmSigner> {
    if (typeof signer !== 'string') {
      assert(
        isTransactionModifyingSigner(signer) ||
          isTransactionPartialSigner(signer),
        'SVM signer must implement transaction modifying or partial signing',
      );
      const { rpc, rpcUrls } = BaseSvmSigner.resolveRpcConnection(metadata);
      return new SvmSigner(rpc, rpcUrls, metadata, signer);
    }
    const { rpc, rpcUrls, keypair } = await BaseSvmSigner.resolveConnection(
      metadata,
      signer,
    );

    return new SvmSigner(rpc, rpcUrls, metadata, keypair);
  }
}
