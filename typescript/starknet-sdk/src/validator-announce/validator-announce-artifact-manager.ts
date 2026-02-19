import { ChainMetadataForAltVM } from '@hyperlane-xyz/provider-sdk';
import { ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { AnnotatedTx, TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedRawValidatorAnnounceArtifact,
  DeployedValidatorAnnounceAddress,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceArtifactConfigs,
  ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { StarknetSigner } from '../clients/signer.js';
import {
  StarknetContractName,
  callContract,
  getStarknetContract,
  normalizeStarknetAddressSafe,
} from '../contracts.js';

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
    const normalizedAddress = normalizeStarknetAddressSafe(address);
    const validatorAnnounce = getStarknetContract(
      StarknetContractName.VALIDATOR_ANNOUNCE,
      normalizedAddress,
    );

    const mailboxAddress = await callContract(validatorAnnounce, 'mailbox').catch(
      () => '',
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        mailboxAddress: mailboxAddress
          ? normalizeStarknetAddressSafe(mailboxAddress)
          : '',
      },
      deployed: {
        address: normalizedAddress,
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
    artifact: ArtifactNew<RawValidatorAnnounceArtifactConfigs['validatorAnnounce']>,
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
          address: normalizeStarknetAddressSafe(deployed.validatorAnnounceId),
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
  constructor(_chainMetadata: ChainMetadataForAltVM) {}

  readValidatorAnnounce(address: string): Promise<DeployedRawValidatorAnnounceArtifact> {
    return this.createReader('validatorAnnounce').read(
      address,
    ) as Promise<DeployedRawValidatorAnnounceArtifact>;
  }

  createReader<T extends ValidatorAnnounceType>(
    type: T,
  ): ArtifactReader<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    if (type !== 'validatorAnnounce') {
      throw new Error(`Unsupported Starknet validator announce type: ${type}`);
    }
    return new StarknetValidatorAnnounceReader() as ArtifactReader<
      RawValidatorAnnounceArtifactConfigs[T],
      DeployedValidatorAnnounceAddress
    >;
  }

  createWriter<T extends ValidatorAnnounceType>(
    type: T,
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    if (type !== 'validatorAnnounce') {
      throw new Error(`Unsupported Starknet validator announce type: ${type}`);
    }
    return new StarknetValidatorAnnounceWriter(
      signer as StarknetSigner,
    ) as ArtifactWriter<
      RawValidatorAnnounceArtifactConfigs[T],
      DeployedValidatorAnnounceAddress
    >;
  }
}
