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
import { assert } from '@hyperlane-xyz/utils';
import { address as parseAddress } from '@solana/kit';

import { type IRawMailboxArtifactManager } from '@hyperlane-xyz/provider-sdk/mailbox';
import { type IRawFeeArtifactManager } from '@hyperlane-xyz/provider-sdk/fee';
import { type IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';
import { SvmMailboxArtifactManager } from '../core/mailbox-artifact-manager.js';
import { SvmValidatorAnnounceArtifactManager } from '../core/validator-announce-artifact-manager.js';
import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { createRpc } from '../rpc.js';
import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { SvmProvider } from './provider.js';
import { SvmSigner } from './signer.js';

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
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    const mailbox = context?.mailbox
      ? parseAddress(context.mailbox)
      : undefined;
    return new SvmHookArtifactManager(rpc, mailbox);
  }

  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmWarpArtifactManager(rpc);
  }

  createMailboxArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawMailboxArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmMailboxArtifactManager(rpc, chainMetadata.domainId);
  }

  createValidatorAnnounceArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawValidatorAnnounceArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmValidatorAnnounceArtifactManager(rpc, chainMetadata.domainId);
  }

  createFeeArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
  ): IRawFeeArtifactManager | null {
    return null;
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 10_000_000_000n,
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
