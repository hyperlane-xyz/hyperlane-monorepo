import {
  RadixSigningSDK,
  transactionManifestFromString,
} from '@hyperlane-xyz/radix-sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { RadixTransaction } from '../../providers/ProviderType.js';
import { ChainName } from '../../types.js';
import { IMultiProtocolSigner } from '../types.js';

export class RadixMultiProtocolSignerAdapter
  implements IMultiProtocolSigner<ProtocolType.Radix>
{
  constructor(
    private readonly chainName: ChainName,
    private readonly signer: RadixSigningSDK,
  ) {}

  static async init(
    chainName: ChainName,
    privateKey: string,
  ): Promise<RadixMultiProtocolSignerAdapter> {
    const signer = await RadixSigningSDK.fromPrivateKey(privateKey);

    return new RadixMultiProtocolSignerAdapter(chainName, signer);
  }

  async address(): Promise<string> {
    return this.signer.getAddress();
  }

  async sendAndConfirmTransaction(tx: RadixTransaction): Promise<string> {
    try {
      let parsedManifest: Exclude<
        RadixTransaction['transaction']['manifest'],
        string
      >;
      if (typeof tx.transaction.manifest === 'string') {
        parsedManifest = await transactionManifestFromString(
          tx.transaction.manifest,
          this.signer.getNetworkId(),
        );
      } else {
        parsedManifest = tx.transaction.manifest;
      }

      await this.signer.base.estimateTransactionFee({
        transactionManifest: parsedManifest,
      });

      const transactionHash =
        await this.signer.signer.signAndBroadcast(parsedManifest);

      await this.signer.base.pollForCommit(transactionHash.id);

      return transactionHash.id;
    } catch (err) {
      throw new Error(`Transaction failed on chain ${this.chainName}`, {
        cause: err,
      });
    }
  }
}
