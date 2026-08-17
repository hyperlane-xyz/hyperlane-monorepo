import {
  type TransactionSigner,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk/chain';
import { type Logger, rootLogger } from '@hyperlane-xyz/utils';

import type { SvmRpc } from '../types.js';

import { BaseSvmSigner, type SignTransactionMessage } from './base-signer.js';

export class SvmSigner extends BaseSvmSigner {
  protected readonly logger: Logger = rootLogger.child({ module: 'SvmSigner' });
  protected readonly signMessage: SignTransactionMessage =
    signTransactionMessageWithSigners;

  private constructor(
    rpc: SvmRpc,
    rpcUrls: string[],
    chainMetadata: ChainMetadataForAltVM,
    signer: TransactionSigner,
  ) {
    super(rpc, rpcUrls, chainMetadata, signer);
  }

  static async connectWithSigner(
    metadata: ChainMetadataForAltVM,
    privateKey: string,
  ): Promise<SvmSigner> {
    const { rpc, rpcUrls, keypair } = await BaseSvmSigner.resolveConnection(
      metadata,
      privateKey,
    );

    return new SvmSigner(rpc, rpcUrls, metadata, keypair);
  }
}
