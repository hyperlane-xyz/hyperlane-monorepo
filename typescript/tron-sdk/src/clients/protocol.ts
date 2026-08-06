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
import { type IRawWarpArtifactManager } from '@hyperlane-xyz/provider-sdk/warp';
import {
  type FeeReadContext,
  type IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import { type IRawValidatorAnnounceArtifactManager } from '@hyperlane-xyz/provider-sdk/validator-announce';

import { TronProvider } from './provider.js';
import { TronSigner } from './signer.js';

// Base router deploy cost in native denom (sun), used to size
// getMinGas().WARP_DEPLOY_GAS. The composable per-config breakdown lives on
// TronProvider.getMinGasForWarpDeploy.
const WARP_DEPLOY_BASE_SUN = BigInt(1e9);

export class TronProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    return TronProvider.connect(chainMetadata);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    const { privateKey } = config;

    return TronSigner.connectWithSigner(chainMetadata, privateKey);
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
}
