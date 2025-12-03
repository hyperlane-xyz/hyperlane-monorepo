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

import { CosmosNativeProvider } from './provider.js';
import { CosmosNativeSigner } from './signer.js';

export class CosmosNativeProtocolProvider implements ProtocolProvider {
  providers = new Providers();
  signers = new Signers();

  async createProvider(
    chainMetadata: ChainMetadataForAltVM,
  ): Promise<IProvider> {
    const { rpcUrls, domainId } = chainMetadata;
    assert(rpcUrls, 'rpc urls undefined');
    const rpcHttpUrls = rpcUrls.map((rpc) => rpc.http);

    const existingProvider = this.providers.getProvider(domainId);
    if (existingProvider) return existingProvider;

    const provider = await CosmosNativeProvider.connect(rpcHttpUrls, domainId);
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

    const signer = await CosmosNativeSigner.connectWithSigner(
      rpcUrls,
      privateKey,
      {
        metadata: chainMetadata,
      },
    );
    this.signers.setSigner(domainId, signer);

    return signer;
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    throw Error('Not implemented');
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: BigInt(1e6),
      WARP_DEPLOY_GAS: BigInt(3e6),
      TEST_SEND_GAS: BigInt(3e5),
      AVS_GAS: BigInt(3e6),
    };
  }
}
