import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { normalizeStarknetAddressSafe } from '../contracts.js';

export class StarknetUnknownHookReader implements ArtifactReader<
  RawHookArtifactConfigs['unknownHook'],
  DeployedHookAddress
> {
  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawHookArtifactConfigs['unknownHook'], DeployedHookAddress>
  > {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: 'unknownHook' },
      deployed: { address: normalizeStarknetAddressSafe(address) },
    };
  }
}

export class StarknetUnknownHookWriter
  extends StarknetUnknownHookReader
  implements
    ArtifactWriter<RawHookArtifactConfigs['unknownHook'], DeployedHookAddress>
{
  async create(
    _artifact: ArtifactNew<RawHookArtifactConfigs['unknownHook']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['unknownHook'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    throw new Error(
      'unknownHook artifacts are read-only on Starknet; deploy noop hooks via signer.createNoopHook',
    );
  }

  async update(
    _artifact: ArtifactDeployed<
      RawHookArtifactConfigs['unknownHook'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}
