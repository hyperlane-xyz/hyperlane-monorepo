import { type ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { type ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactReader,
  type ArtifactWriter,
  ArtifactComposition,
  type OrchestratedArtifactReader,
  type OrchestratedArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  type DeployedRawWarpArtifact,
  type DeployedWarpAddress,
  type IRawWarpArtifactManager,
  type WarpArtifactConfigs,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
import { StarknetSigner } from '../clients/signer.js';
import {
  StarknetCollateralTokenReader,
  StarknetCollateralTokenWriter,
} from './collateral-token-artifact-manager.js';
import {
  StarknetNativeTokenReader,
  StarknetNativeTokenWriter,
} from './native-token-artifact-manager.js';
import {
  StarknetSyntheticTokenReader,
  StarknetSyntheticTokenWriter,
} from './synthetic-token-artifact-manager.js';
import { getStarknetWarpType } from './token-artifact-manager.js';

export class StarknetWarpArtifactManager implements IRawWarpArtifactManager {
  private readonly provider: StarknetProvider;

  constructor(chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  supportsHookUpdates(): boolean {
    return true;
  }

  async readWarpToken(address: string): Promise<DeployedRawWarpArtifact> {
    const token = await this.provider.getToken({ tokenAddress: address });
    return this.createReader(getStarknetWarpType(token.tokenType)).read(
      address,
    );
  }

  createReader<T extends WarpType>(
    type: T,
  ): ArtifactReader<WarpArtifactConfigs[T], DeployedWarpAddress> {
    const readers: {
      [K in WarpType]: OrchestratedArtifactReader<
        WarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      native: new StarknetNativeTokenReader(this.provider),
      collateral: new StarknetCollateralTokenReader(this.provider),
      synthetic: new StarknetSyntheticTokenReader(this.provider),
      crossCollateral: {
        composition: ArtifactComposition.ORCHESTRATED,
        read: async () => {
          throw new Error(
            'Cross-collateral tokens are not supported on Starknet',
          );
        },
      },
    };
    return readers[type];
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<WarpArtifactConfigs[T], DeployedWarpAddress> {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');

    const writers: {
      [K in WarpType]: OrchestratedArtifactWriter<
        WarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      native: new StarknetNativeTokenWriter(this.provider, signer),
      collateral: new StarknetCollateralTokenWriter(this.provider, signer),
      synthetic: new StarknetSyntheticTokenWriter(this.provider, signer),
      crossCollateral: {
        composition: ArtifactComposition.ORCHESTRATED,
        read: async () => {
          throw new Error(
            'Cross-collateral tokens are not supported on Starknet',
          );
        },
        create: async () => {
          throw new Error(
            'Cross-collateral tokens are not supported on Starknet',
          );
        },
        update: async () => {
          throw new Error(
            'Cross-collateral tokens are not supported on Starknet',
          );
        },
      },
    };
    return writers[type];
  }
}
