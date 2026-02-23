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
import { assert } from '@hyperlane-xyz/utils';

import { StarknetProvider } from '../clients/provider.js';
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
  constructor(private readonly provider: StarknetProvider) {}

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
      this.provider.getRawProvider(),
    );

    const mailboxAddress = await callContract(
      validatorAnnounce,
      'mailbox',
    ).catch(() => '');

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
  constructor(
    provider: StarknetProvider,
    private readonly signer: StarknetSigner,
  ) {
    super(provider);
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
  private readonly provider: StarknetProvider;

  constructor(chainMetadata: ChainMetadataForAltVM) {
    this.provider = StarknetProvider.connect(
      (chainMetadata.rpcUrls ?? []).map(({ http }) => http),
      chainMetadata.chainId,
      { metadata: chainMetadata },
    );
  }

  private requireStarknetSigner(
    signer: ISigner<AnnotatedTx, TxReceipt>,
  ): StarknetSigner {
    assert(signer instanceof StarknetSigner, 'Expected StarknetSigner');
    return signer;
  }

  readValidatorAnnounce(
    address: string,
  ): Promise<DeployedRawValidatorAnnounceArtifact> {
    return this.createReader('validatorAnnounce').read(address);
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
    const readers: {
      [K in ValidatorAnnounceType]: ArtifactReader<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: new StarknetValidatorAnnounceReader(this.provider),
    };
    return readers[type];
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
    const starknetSigner = this.requireStarknetSigner(signer);
    const writers: {
      [K in ValidatorAnnounceType]: ArtifactWriter<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: new StarknetValidatorAnnounceWriter(
        this.provider,
        starknetSigner,
      ),
    };
    return writers[type];
  }
}
