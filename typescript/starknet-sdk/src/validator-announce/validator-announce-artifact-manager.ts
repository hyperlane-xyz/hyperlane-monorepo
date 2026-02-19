import type { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import type { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  AnnotatedTx,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import type {
  DeployedValidatorAnnounceAddress,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceArtifactConfigs,
  ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { StarknetProvider } from '../clients/provider.js';
import type { StarknetSigner } from '../clients/signer.js';

class StarknetValidatorAnnounceReader
  implements
    ArtifactReader<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >
{
  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >
  > {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        mailboxAddress: '',
      },
      deployed: {
        address,
      },
    };
  }
}

class StarknetValidatorAnnounceWriter
  extends StarknetValidatorAnnounceReader
  implements
    ArtifactWriter<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >
{
  constructor(private readonly signer: StarknetSigner) {
    super();
  }

  async create(
    artifact: ArtifactNew<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce']
    >,
  ): Promise<
    [
      ArtifactDeployed<
        RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
        DeployedValidatorAnnounceAddress
      >,
      TxReceipt[],
    ]
  > {
    const deployed = await this.signer.createValidatorAnnounce({
      mailboxAddress: artifact.config.mailboxAddress,
    });
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: {
          address: deployed.validatorAnnounceId,
        },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawValidatorAnnounceArtifactConfigs['validatorAnnounce'],
      DeployedValidatorAnnounceAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}

export class StarknetValidatorAnnounceArtifactManager
  implements IRawValidatorAnnounceArtifactManager
{
  constructor(chainMetadata: ChainMetadataForAltVM) {
    StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map((rpc: { http: string }) => rpc.http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  async readValidatorAnnounce(address: string) {
    return this.createReader('validatorAnnounce').read(address);
  }

  createReader<T extends ValidatorAnnounceType>(
    _type: T,
  ): ArtifactReader<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    return new StarknetValidatorAnnounceReader() as ArtifactReader<
      RawValidatorAnnounceArtifactConfigs[T],
      DeployedValidatorAnnounceAddress
    >;
  }

  createWriter<T extends ValidatorAnnounceType>(
    _type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    return new StarknetValidatorAnnounceWriter(
      signer as StarknetSigner,
    ) as ArtifactWriter<
      RawValidatorAnnounceArtifactConfigs[T],
      DeployedValidatorAnnounceAddress
    >;
  }
}
