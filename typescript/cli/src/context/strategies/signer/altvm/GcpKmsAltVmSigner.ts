import {
  type AltVM,
  type ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { SealevelSigner } from '@hyperlane-xyz/sealevel-sdk';
import { assert, ProtocolType } from '@hyperlane-xyz/utils';

import { GcpKmsSvmSigner } from './GcpKmsSvmSigner.js';

export async function createGcpKmsAltVmSigner(
  metadata: ChainMetadataForAltVM,
  keyId: string,
): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
  switch (metadata.protocol) {
    case ProtocolType.Sealevel: {
      const rpcUrls = (metadata.rpcUrls ?? []).map((r) => r.http);
      assert(
        rpcUrls.length > 0,
        `No RPC URLs for Sealevel chain ${metadata.name}`,
      );
      const kmsSigner = await GcpKmsSvmSigner.create(keyId);
      return SealevelSigner.connectWithTransactionSigner(rpcUrls, kmsSigner);
    }
    default:
      throw new Error(
        `GCP KMS signing not yet supported for protocol ${metadata.protocol} on chain ${metadata.name}`,
      );
  }
}
