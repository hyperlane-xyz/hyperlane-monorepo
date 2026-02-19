import {
  type AltVM,
  type ChainMetadataForAltVM,
  type ITransactionSubmitter,
  type MinimumRequiredGasByAction,
  type ProtocolProvider,
  type SignerConfig,
  type TransactionSubmitterConfig,
} from '@hyperlane-xyz/provider-sdk';
import { type IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import { type IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import { type IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import { type IRawMailboxArtifactManager } from '@hyperlane-xyz/provider-sdk/mailbox';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { type IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import { StarknetValidatorAnnounceArtifactManager } from '../validator-announce/validator-announce-artifact-manager.js';

import { StarknetProvider } from './provider.js';
import { StarknetSigner } from './signer.js';

export class StarknetProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    const rpcUrls = (chainMetadata.rpcUrls ?? []).map(
      (rpc: { http: string }) => rpc.http,
    );
    assert(rpcUrls.length > 0, 'rpc urls undefined for Starknet');
    return Promise.resolve(
      StarknetProvider.connect(rpcUrls, chainMetadata.chainId, {
        metadata: chainMetadata,
      }),
    );
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    const rpcUrls = (chainMetadata.rpcUrls ?? []).map(
      (rpc: { http: string }) => rpc.http,
    );
    assert(rpcUrls.length > 0, 'rpc urls undefined for Starknet');
    assert(config.privateKey, 'privateKey missing for Starknet signer');
    assert(config.accountAddress, 'accountAddress missing for Starknet signer');
    return StarknetSigner.connectWithSigner(rpcUrls, config.privateKey, {
      metadata: chainMetadata,
      accountAddress: config.accountAddress,
    });
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    throw new Error('Not implemented');
  }

  createIsmArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager {
    return new StarknetIsmArtifactManager(chainMetadata);
  }

  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ): IRawHookArtifactManager {
    return new StarknetHookArtifactManager(chainMetadata, context);
  }

  createMailboxArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawMailboxArtifactManager {
    return new StarknetMailboxArtifactManager(chainMetadata);
  }

  createValidatorAnnounceArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawValidatorAnnounceArtifactManager | null {
    return new StarknetValidatorAnnounceArtifactManager(chainMetadata);
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 0n,
      WARP_DEPLOY_GAS: 0n,
      TEST_SEND_GAS: 0n,
      AVS_GAS: 0n,
      ISM_DEPLOY_GAS: 0n,
    };
  }
}
