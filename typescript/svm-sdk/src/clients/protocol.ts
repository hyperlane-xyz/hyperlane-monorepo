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
import type {
  IRawWarpArtifactManager,
  WarpConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
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
import { SvmProvider } from './provider.js';
import { SvmSigner } from './signer.js';

// Warp-deploy cost breakdown for Sealevel. Composed additively in
// getMinGasForWarpDeploy() based on the WarpConfig shape.
//
// Numbers observed from live cross-collateral + fee-program deploys on
// mainnet-beta; the base value matches the flat WARP_DEPLOY_GAS used before
// this method existed (~2.6 SOL covers program account rent + token PDA rent
// + ATA payer funding for a base router).
const WARP_DEPLOY_BASE_LAMPORTS = 2_600_000_000n; // base router deploy
const WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS = 1_100_000_000n; // + crossCollateral router extras (~1.1 SOL)
const WARP_DEPLOY_FEE_PROGRAM_LAMPORTS = 2_500_000_000n; // + fee program deploy (~2.5 SOL, separate program)
// TODO: fill from observed deploy — we don't have a measured breakdown for
// custom ISM / hook deploys on Sealevel yet, so these currently contribute
// nothing until real numbers land.
const WARP_DEPLOY_CUSTOM_ISM_LAMPORTS = 0n; // + custom ISM (config.interchainSecurityModule object)
const WARP_DEPLOY_CUSTOM_HOOK_LAMPORTS = 0n; // + custom hook / IGP (config.hook object)

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

  getMinGasForWarpDeploy(warpConfig: WarpConfig): bigint {
    let total = WARP_DEPLOY_BASE_LAMPORTS;

    if (warpConfig.type === 'crossCollateral') {
      total += WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_LAMPORTS;
    }

    // A string fee/ism/hook value references an existing on-chain contract
    // by address — no deploy cost. An object value triggers a fresh deploy
    // whose rent/storage footprint is added to the preflight budget.
    if (warpConfig.fee !== undefined && typeof warpConfig.fee === 'object') {
      total += WARP_DEPLOY_FEE_PROGRAM_LAMPORTS;
    }

    if (
      warpConfig.interchainSecurityModule !== undefined &&
      typeof warpConfig.interchainSecurityModule === 'object'
    ) {
      total += WARP_DEPLOY_CUSTOM_ISM_LAMPORTS;
    }

    if (warpConfig.hook !== undefined && typeof warpConfig.hook === 'object') {
      total += WARP_DEPLOY_CUSTOM_HOOK_LAMPORTS;
    }

    return total;
  }

  private getRpcUrls(chainMetadata: ChainMetadataForAltVM): string[] {
    assert(
      chainMetadata.rpcUrls && chainMetadata.rpcUrls.length > 0,
      'At least one RPC URL is required',
    );
    return chainMetadata.rpcUrls.map((r) => r.http);
  }
}
