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
import { assert } from '@hyperlane-xyz/utils';

import { CosmosHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { CosmosIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { CosmosWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { CosmosNativeProvider } from './provider.js';
import { CosmosNativeSigner } from './signer.js';
import { CosmosMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';

// Base router deploy cost in gas units (ugas), used to size
// getMinGas().WARP_DEPLOY_GAS. The composable per-config breakdown lives on
// CosmosNativeProvider.getMinGasForWarpDeploy.
const WARP_DEPLOY_BASE_UGAS = BigInt(3e6);

export class CosmosNativeProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    return CosmosNativeProvider.connect(chainMetadata);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    const { privateKey } = config;

    return CosmosNativeSigner.connectWithSigner(chainMetadata, privateKey);
  }

  createSubmitter<TConfig extends TransactionSubmitterConfig>(
    _chainMetadata: ChainMetadataForAltVM,
    _config: TConfig,
  ): Promise<ITransactionSubmitter> {
    // @TODO Implement in a follow up PR
    throw Error('Not implemented');
  }

  createIsmArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    return new CosmosIsmArtifactManager(rpcUrls);
  }

  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string },
  ): IRawHookArtifactManager {
    const [mainRpcUrl, ...otherRpcUrls] = (chainMetadata.rpcUrls ?? []).map(
      (rpc) => rpc.http,
    );

    assert(mainRpcUrl, 'At least one rpc url is required');
    assert(chainMetadata.nativeToken?.denom, 'native token denom undefined');

    const mailboxAddress = context?.mailbox;
    const nativeTokenDenom = chainMetadata.nativeToken.denom;

    return new CosmosHookArtifactManager({
      rpcUrls: [mainRpcUrl, ...otherRpcUrls],
      mailboxAddress,
      nativeTokenDenom,
    });
  }

  createWarpArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    _context?: { mailbox?: string },
  ): IRawWarpArtifactManager {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    return new CosmosWarpArtifactManager(rpcUrls);
  }

  createMailboxArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
  ): IRawMailboxArtifactManager {
    const [rpcUrl, ...otherRpcUrls] =
      chainMetadata.rpcUrls?.map((rpc) => rpc.http) ?? [];
    assert(
      rpcUrl,
      `Expected at least one rpc url for chain ${chainMetadata.name}`,
    );

    return new CosmosMailboxArtifactManager({
      domainId: chainMetadata.domainId,
      rpcUrls: [rpcUrl, ...otherRpcUrls],
    });
  }

  createValidatorAnnounceArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
  ): IRawValidatorAnnounceArtifactManager | null {
    // Cosmos does not support validator announce
    return null;
  }

  createFeeArtifactManager(
    _chainMetadata: ChainMetadataForAltVM,
    _context: FeeReadContext,
  ): IRawFeeArtifactManager | null {
    return null;
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: BigInt(1e6),
      WARP_DEPLOY_GAS: WARP_DEPLOY_BASE_UGAS,
      TEST_SEND_GAS: BigInt(3e5),
      AVS_GAS: BigInt(3e6),
      ISM_DEPLOY_GAS: BigInt(5e5),
      HOOK_DEPLOY_GAS: BigInt(5e5),
    };
  }
}
