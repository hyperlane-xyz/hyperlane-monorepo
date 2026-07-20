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
import {
  composeWarpDeployGas,
  type IRawWarpArtifactManager,
  type WarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  type FeeReadContext,
  type IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import { type IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';
import { assert } from '@hyperlane-xyz/utils';

import { TronProvider } from './provider.js';
import { TronSigner } from './signer.js';

// Warp-deploy cost breakdown for Tron. Composed additively in
// getMinGasForWarpDeploy() based on the WarpConfig shape.
//
// TODO: fill from observed deploy — we don't have a measured breakdown for
// feature-heavy warp deploys on Tron yet, so all extras currently contribute
// nothing and getMinGasForWarpDeploy returns getMinGas().WARP_DEPLOY_GAS.
const WARP_DEPLOY_BASE_SUN = BigInt(1e9); // base router deploy
const WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_SUN = 0n; // + crossCollateral router extras
const WARP_DEPLOY_FEE_PROGRAM_SUN = 0n; // + fee program (config.fee object)
const WARP_DEPLOY_CUSTOM_ISM_SUN = 0n; // + custom ISM (config.interchainSecurityModule object)
const WARP_DEPLOY_CUSTOM_HOOK_SUN = 0n; // + custom hook / IGP (config.hook object)

export class TronProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    return TronProvider.connect(rpcUrls);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = config;

    return TronSigner.connectWithSigner(rpcUrls, privateKey, {
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

  createIsmArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  createHookArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string; proxyAdmin?: string },
  ): IRawHookArtifactManager {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  createWarpArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  createMailboxArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
  ): IRawMailboxArtifactManager {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  createValidatorAnnounceArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
  ): IRawValidatorAnnounceArtifactManager | null {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
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
      WARP_DEPLOY_GAS: WARP_DEPLOY_BASE_SUN,
      ISM_DEPLOY_GAS: BigInt(1e9),
      HOOK_DEPLOY_GAS: BigInt(1e9),
      TEST_SEND_GAS: BigInt(1e9),
      AVS_GAS: BigInt(1e9),
    };
  }

  getMinGasForWarpDeploy(warpConfig: WarpArtifactConfig): bigint {
    return composeWarpDeployGas(warpConfig, {
      base: WARP_DEPLOY_BASE_SUN,
      crossCollateralExtra: WARP_DEPLOY_CROSS_COLLATERAL_EXTRA_SUN,
      feeProgram: WARP_DEPLOY_FEE_PROGRAM_SUN,
      customIsm: WARP_DEPLOY_CUSTOM_ISM_SUN,
      customHook: WARP_DEPLOY_CUSTOM_HOOK_SUN,
    });
  }
}
