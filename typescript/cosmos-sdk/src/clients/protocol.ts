import {
  type AltVM,
  type ChainMetadataForAltVM,
  HookArtifactManager,
  type ITransactionSubmitter,
  IsmArtifactManager,
  type MinimumRequiredGasByAction,
  type ProtocolProvider,
  type SignerConfig,
  type TransactionSubmitterConfig,
} from '@hyperlane-xyz/provider-sdk';
import { type IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import { type IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import { type IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { CosmosNativeProvider } from './provider.js';
import { CosmosNativeSigner } from './signer.js';

export class CosmosNativeProtocolProvider implements ProtocolProvider {
  async createProvider(
    chainMetadata: ChainMetadataForAltVM,
  ): Promise<IProvider> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    return CosmosNativeProvider.connect(rpcUrls, chainMetadata.domainId);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = config;

    return CosmosNativeSigner.connectWithSigner(rpcUrls, privateKey, {
      metadata: chainMetadata,
    });
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  async createIsmArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): Promise<IRawIsmArtifactManager> {
    const provider = await this.createProvider(chainMetadata);

    return new IsmArtifactManager(provider);
  }

  async createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string; denom?: string },
  ): Promise<IRawHookArtifactManager> {
    assert(
      context?.mailbox,
      `mailbox address required for hook artifact manager`,
    );
    assert(context?.denom, `denom required for hook artifact manager`);

    const provider = await this.createProvider(chainMetadata);
    return new HookArtifactManager(provider, context?.mailbox, context?.denom);
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
