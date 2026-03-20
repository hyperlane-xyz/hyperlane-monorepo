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

import { StarknetSigner } from '../clients/signer.js';
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
  constructor(private readonly signer: StarknetSigner) {
    super();
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['unknownHook']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['unknownHook'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    const deployed = await this.signer.createNoopHook({ mailboxAddress: '' });

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: deployed.hookAddress },
      },
      [],
    ];
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
