import {
  AltVM,
  ChainMetadataForAltVM,
  ITransactionSubmitter,
  MinimumRequiredGasByAction,
  ProtocolProvider,
  SignerConfig,
  TransactionSubmitterConfig,
} from '@hyperlane-xyz/provider-sdk';
import type { IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import type { IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import type { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import type { IRawWarpArtifactManager } from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { createRpc } from '../rpc.js';

import { SealevelProvider } from './provider.js';
import { SealevelSigner } from './signer.js';

export class SealevelProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    const rpcUrls = this.getRpcUrls(chainMetadata);
    return SealevelProvider.connect(rpcUrls, chainMetadata.chainId);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    const rpcUrls = this.getRpcUrls(chainMetadata);
    return SealevelSigner.connectWithSigner(rpcUrls, config.privateKey);
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    throw new Error('Transaction submitter not yet implemented for Sealevel');
  }

  createIsmArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmIsmArtifactManager(rpc);
  }

  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawHookArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmHookArtifactManager(rpc);
  }

  createWarpArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    throw new Error('Warp artifact manager not yet implemented for Sealevel');
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

  private getRpcUrls(chainMetadata: ChainMetadataForAltVM): string[] {
    assert(
      chainMetadata.rpcUrls && chainMetadata.rpcUrls.length > 0,
      'At least one RPC URL is required',
    );
    return chainMetadata.rpcUrls.map((r) => r.http);
  }
}
