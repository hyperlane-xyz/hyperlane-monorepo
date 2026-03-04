import type {
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
import { address as parseAddress } from '@solana/kit';
import { assert } from '@hyperlane-xyz/utils';
import { address, address as parseAddress } from '@solana/kit';

import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { createRpc } from '../rpc.js';

import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { SvmProvider } from './provider.js';
import { SvmSigner } from './signer.js';
import { SVM_CORE_ADDRESSES } from '../generated/core-addresses.js';

export class SvmProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    const rpcUrls = this.getRpcUrls(chainMetadata);
    return SvmProvider.connect(rpcUrls, chainMetadata.chainId);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    const rpcUrls = this.getRpcUrls(chainMetadata);
    return SvmSigner.connectWithSigner(rpcUrls, config.privateKey);
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
    context?: { mailbox?: string },
  ): IRawHookArtifactManager {
    assert(
      context?.mailbox,
      'Mailbox address is required for SVM hook artifact manager',
    );
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmHookArtifactManager(rpc, parseAddress(context.mailbox));
  }

  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);

    const { overheadIgpAccount, igpProgramId } =
      SVM_CORE_ADDRESSES[chainMetadata.name] ?? {};

    assert(
      overheadIgpAccount && igpProgramId,
      `IGP program id and overhead id are required for warp SVM deployments but none were found for chain ${chainMetadata.name}`,
    );
    return new SvmWarpArtifactManager(rpc, {
      igpOverheadProgramId: address(overheadIgpAccount),
      igpProgramId: parseAddress(igpProgramId),
    });
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 0n,
      // ~2.6 SOL covers program account rent + token PDA rent + ATA payer funding
      WARP_DEPLOY_GAS: 2_600_000_000n,
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
