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
import { IRawHookArtifactManager } from '@hyperlane-xyz/provider-sdk/hook';
import { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import { IRawMailboxArtifactManager } from '@hyperlane-xyz/provider-sdk/mailbox';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  FeeReadContext,
  IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import { IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';
import {
  IRawWarpArtifactManager,
  WarpConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { StarknetIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { StarknetMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import { StarknetValidatorAnnounceArtifactManager } from '../validator-announce/validator-announce-artifact-manager.js';
import { StarknetWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { StarknetProvider } from './provider.js';
import { StarknetSigner } from './signer.js';

// Warp-deploy cost breakdown for Starknet. Composed additively in
// getMinGasForWarpDeploy() based on the WarpConfig shape.
//
// TODO: fill from observed deploy — we don't have a measured breakdown for
// feature-heavy warp deploys on Starknet yet, so all extras currently
// contribute nothing and getMinGasForWarpDeploy returns
// getMinGas().WARP_DEPLOY_GAS.
const WARP_DEPLOY_BASE_FRI = BigInt(3e8); // base router deploy
const WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_FRI = 0n; // + crossCollateral router extras
const WARP_DEPLOY_FEE_PROGRAM_FRI = 0n; // + fee program (config.fee object)
const WARP_DEPLOY_CUSTOM_ISM_FRI = 0n; // + custom ISM (config.interchainSecurityModule object)
const WARP_DEPLOY_CUSTOM_HOOK_FRI = 0n; // + custom hook / IGP (config.hook object)

export class StarknetProtocolProvider implements ProtocolProvider {
  async createProvider(
    chainMetadata: ChainMetadataForAltVM,
  ): Promise<IProvider> {
    const rpcUrls = (chainMetadata.rpcUrls ?? []).map(({ http }) => http);
    assert(rpcUrls.length > 0, 'rpc urls undefined for Starknet');
    return StarknetProvider.connect(rpcUrls, chainMetadata.chainId, {
      metadata: chainMetadata,
    });
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    const rpcUrls = (chainMetadata.rpcUrls ?? []).map(({ http }) => http);
    assert(rpcUrls.length > 0, 'rpc urls undefined for Starknet');
    assert(config.privateKey, 'privateKey missing for Starknet signer');
    assert(config.accountAddress, 'accountAddress missing for Starknet signer');

    return StarknetSigner.connectWithSigner(rpcUrls, config.privateKey, {
      metadata: chainMetadata,
      accountAddress: config.accountAddress,
    });
  }

  async createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    throw Error('Not implemented');
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

  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    return new StarknetWarpArtifactManager(chainMetadata);
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

  createFeeArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
    _context: FeeReadContext,
  ): IRawFeeArtifactManager | null {
    return null;
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: BigInt(1e9),
      WARP_DEPLOY_GAS: WARP_DEPLOY_BASE_FRI,
      TEST_SEND_GAS: BigInt(3e7),
      AVS_GAS: BigInt(3e8),
      ISM_DEPLOY_GAS: BigInt(5e7),
      HOOK_DEPLOY_GAS: BigInt(5e7),
    };
  }

  getMinGasForWarpDeploy(warpConfig: WarpConfig): bigint {
    let total = WARP_DEPLOY_BASE_FRI;

    if (warpConfig.type === 'crossCollateral') {
      total += WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_FRI;
    }

    // A string fee/ism/hook value references an existing on-chain contract
    // by address — no deploy cost. An object value triggers a fresh deploy
    // whose footprint is added to the preflight budget.
    if (warpConfig.fee !== undefined && typeof warpConfig.fee === 'object') {
      total += WARP_DEPLOY_FEE_PROGRAM_FRI;
    }

    if (
      warpConfig.interchainSecurityModule !== undefined &&
      typeof warpConfig.interchainSecurityModule === 'object'
    ) {
      total += WARP_DEPLOY_CUSTOM_ISM_FRI;
    }

    if (warpConfig.hook !== undefined && typeof warpConfig.hook === 'object') {
      total += WARP_DEPLOY_CUSTOM_HOOK_FRI;
    }

    return total;
  }
}
