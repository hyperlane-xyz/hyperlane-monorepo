import { AleoNetworkClient as AleoMainnetNetworkClient } from '@provablehq/sdk/mainnet.js';
import { AleoNetworkClient as AleoTestnetNetworkClient } from '@provablehq/sdk/testnet.js';

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
import { IRawIsmArtifactManager } from '@hyperlane-xyz/provider-sdk/ism';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { AleoIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { AleoNetworkId } from '../utils/types.js';

import { AleoProvider } from './provider.js';
import { AleoSigner } from './signer.js';

export class AleoProtocolProvider implements ProtocolProvider {
  createProvider(chainMetadata: ChainMetadataForAltVM): Promise<IProvider> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);
    return AleoProvider.connect(rpcUrls, chainMetadata.chainId);
  }

  async createSigner(
    chainMetadata: ChainMetadataForAltVM,
    config: SignerConfig,
  ): Promise<AltVM.ISigner<AnnotatedTx, TxReceipt>> {
    assert(chainMetadata.rpcUrls, 'rpc urls undefined');
    const rpcUrls = chainMetadata.rpcUrls.map((rpc) => rpc.http);

    const { privateKey } = config;

    return AleoSigner.connectWithSigner(rpcUrls, privateKey, {
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
    const chainId = parseInt(chainMetadata.chainId.toString());
    assert(
      chainId === AleoNetworkId.MAINNET || chainId === AleoNetworkId.TESTNET,
      `Unknown chain id ${chainId} for Aleo, only ${AleoNetworkId.MAINNET} or ${AleoNetworkId.TESTNET} allowed`,
    );

    const [rpcUrl] = chainMetadata.rpcUrls?.map(({ http }) => http) ?? [];
    assert(rpcUrl, `got no rpcUrls`);

    const aleoClient =
      chainId === AleoNetworkId.MAINNET
        ? new AleoMainnetNetworkClient(rpcUrl)
        : new AleoTestnetNetworkClient(rpcUrl);

    return new AleoIsmArtifactManager(aleoClient);
  }

  getMinGas(): MinimumRequiredGasByAction {
    return {
      CORE_DEPLOY_GAS: 0n,
      WARP_DEPLOY_GAS: 0n,
      TEST_SEND_GAS: 0n,
      AVS_GAS: 0n,
    };
  }
}
