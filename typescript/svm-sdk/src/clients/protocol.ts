import type {
  AltVM,
  ChainMetadataForAltVM,
  ITransactionSubmitter,
  MinimumRequiredGasByAction,
  ProtocolProvider,
  SignerConfig,
  TransactionSubmitterConfig,
} from '@hyperlane-xyz/provider-sdk';
import {
  AltVMImpersonatedSubmitter,
  AltVMJsonRpcSubmitter,
  SubmitterType,
} from '@hyperlane-xyz/provider-sdk';
import type { IProvider } from '@hyperlane-xyz/provider-sdk/altvm';
import type { IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import type { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { type IRawWarpArtifactManager } from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';
import { address as parseAddress } from '@solana/kit';

import { type IRawMailboxArtifactManager } from '@hyperlane-xyz/provider-sdk/mailbox';
import {
  type FeeReadContext,
  type IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import { type IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';
import { SvmMailboxArtifactManager } from '../core/mailbox-artifact-manager.js';
import { SvmValidatorAnnounceArtifactManager } from '../core/validator-announce-artifact-manager.js';
import { SvmFeeArtifactManager } from '../fee/fee-artifact-manager.js';
import { resolveFeeSalt } from '../fee/types.js';
import { SvmHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { SvmIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { createRpc } from '../rpc.js';
import { SvmWarpArtifactManager } from '../warp/warp-artifact-manager.js';
import { SvmImpersonatingSigner } from './impersonating-signer.js';
import { SvmProvider, WARP_DEPLOY_BASE_LAMPORTS } from './provider.js';
import { SvmSigner } from './signer.js';

export class SvmProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    return SvmProvider.connect(chainMetadata);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    return SvmSigner.connectWithSigner(chainMetadata, config.privateKey);
  }

  async createSubmitter<TConfig extends TransactionSubmitterConfig>(
    chainMetadata: ChainMetadataForAltVM,
    config: TConfig,
  ): Promise<ITransactionSubmitter> {
    const submitterConfig: TransactionSubmitterConfig = config;
    const { chain } = submitterConfig;

    switch (submitterConfig.type) {
      case SubmitterType.JsonRpc: {
        const signer = await SvmSigner.connectWithSigner(
          chainMetadata,
          submitterConfig.privateKey,
        );
        return new AltVMJsonRpcSubmitter(signer, { chain });
      }
      case SubmitterType.ImpersonatedAccount: {
        const signer = await SvmImpersonatingSigner.create(
          chainMetadata,
          submitterConfig.userAddress,
        );
        return new AltVMImpersonatedSubmitter(signer, { chain });
      }
      case SubmitterType.File:
        throw new Error(
          `File submission is a Node/CLI-layer concern and is not available via the browser-safe Sealevel provider (submitter type: ${submitterConfig.type})`,
        );
      default: {
        const _exhaustive: never = submitterConfig;
        throw new Error(`Unhandled submitter type: ${_exhaustive}`);
      }
    }
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
    return new SvmHookArtifactManager(rpc, chainMetadata.domainId, mailbox);
  }

  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmWarpArtifactManager(rpc, {
      chainName: chainMetadata.name,
    });
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
    chainMetadata: ChainMetadataForAltVM,
    context: FeeReadContext,
  ): IRawFeeArtifactManager | null {
    const rpc = createRpc(this.getRpcUrls(chainMetadata)[0]);
    return new SvmFeeArtifactManager(
      rpc,
      context,
      { domainId: chainMetadata.domainId, chainName: chainMetadata.name },
      resolveFeeSalt(chainMetadata.name),
    );
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 10_000_000_000n,
      // Base-router case: ~2.6 SOL covers program account rent + token PDA
      // rent + ATA payer funding. Feature-heavy deploys (cross-collateral,
      // fee program, custom ISM/hook) need more — use getMinGasForWarpDeploy
      // for the composable equivalent.
      WARP_DEPLOY_GAS: WARP_DEPLOY_BASE_LAMPORTS,
      TEST_SEND_GAS: 0n,
      AVS_GAS: 0n,
      ISM_DEPLOY_GAS: 0n,
      HOOK_DEPLOY_GAS: 0n,
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
