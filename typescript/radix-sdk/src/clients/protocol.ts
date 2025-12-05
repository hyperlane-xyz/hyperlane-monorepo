import {
  AltVM,
  ChainMetadataForAltVM,
  ITransactionSubmitter,
  MinimumRequiredGasByAction,
  ProtocolProvider,
  SignerConfig,
  TransactionSubmitterConfig,
} from '@hyperlane-xyz/provider-sdk';
import { IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { Providers, Signers } from '@hyperlane-xyz/provider-sdk/protocol';
import { assert } from '@hyperlane-xyz/utils';

import { RadixProvider } from './provider.js';
import { RadixSigner } from './signer.js';

export class RadixProtocolProvider implements ProtocolProvider {
  providers = new Providers();
  signers = new Signers();

  async createProvider(
    chainMetadata: ChainMetadataForAltVM,
  ): Promise<IProvider> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    const { domainId } = chainMetadata;

    const existingProvider = this.providers.getProvider(domainId);
    if (existingProvider) return existingProvider;

    const provider = await RadixProvider.connect(
      rpcUrls,
      chainMetadata.chainId,
      {
        metadata: chainMetadata,
      },
    );
    this.providers.setProvider(domainId, provider);

    return provider;
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = config;
    const { domainId } = chainMetadata;

    const existingSigner = this.signers.getSigner(domainId);
    if (existingSigner) return existingSigner;

    const signer = await RadixSigner.connectWithSigner(rpcUrls, privateKey, {
      metadata: chainMetadata,
    });
    this.signers.setSigner(domainId, signer);

    return signer;
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 0n,
      WARP_DEPLOY_GAS: 0n,
      TEST_SEND_GAS: 0n,
      AVS_GAS: 0n,
    };
  }
}
