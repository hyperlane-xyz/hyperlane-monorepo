import { TronWeb } from 'tronweb';

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
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert, strip0x } from '@hyperlane-xyz/utils';

import { TronHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { TronIsmArtifactManager } from '../ism/ism-artifact-manager.js';

import { TronProvider } from './provider.js';
import { TronSigner } from './signer.js';

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
    chainMetadata: ChainMetadataForAltVM,
  ): IRawIsmArtifactManager {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = new TronWeb({
      fullHost: rpcUrls[0],
    }).createRandom();

    const tronweb = new TronWeb({
      fullHost: rpcUrls[0],
      privateKey: strip0x(privateKey),
    });

    return new TronIsmArtifactManager(tronweb);
  }

  createHookArtifactManager(
    chainMetadata: ChainMetadataForAltVM,
    context?: { mailbox?: string; proxyAdmin?: string },
  ): IRawHookArtifactManager {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = new TronWeb({
      fullHost: rpcUrls[0],
    }).createRandom();

    const tronweb = new TronWeb({
      fullHost: rpcUrls[0],
      privateKey: strip0x(privateKey),
    });

    const mailboxAddress = context?.mailbox ?? '';
    const proxyAdminAddress = context?.proxyAdmin ?? '';

    return new TronHookArtifactManager(
      tronweb,
      mailboxAddress,
      proxyAdminAddress,
    );
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: BigInt(1e9),
      WARP_DEPLOY_GAS: BigInt(1e9),
      TEST_SEND_GAS: BigInt(1e9),
      AVS_GAS: BigInt(1e9),
    };
  }
}
