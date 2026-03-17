import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedValidatorAnnounceAddress,
  RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getValidatorAnnounceConfig } from './validator-announce-query.js';
import { getCreateValidatorAnnounceTx } from './validator-announce-tx.js';

export class RadixValidatorAnnounceReader implements ArtifactReader<
  RawValidatorAnnounceConfig,
  DeployedValidatorAnnounceAddress
> {
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >
  > {
    const validatorAnnounceConfig = await getValidatorAnnounceConfig(
      this.gateway,
      address,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        mailboxAddress: validatorAnnounceConfig.mailboxAddress,
      },
      deployed: {
        address: validatorAnnounceConfig.address,
      },
    };
  }
}

export class RadixValidatorAnnounceWriter
  extends RadixValidatorAnnounceReader
  implements
    ArtifactWriter<RawValidatorAnnounceConfig, DeployedValidatorAnnounceAddress>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<RawValidatorAnnounceConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        RawValidatorAnnounceConfig,
        DeployedValidatorAnnounceAddress
      >,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    // Create the validator announce contract
    const createTx = await getCreateValidatorAnnounceTx(
      this.base,
      this.signer.getAddress(),
      config.mailboxAddress,
    );

    const createReceipt = await this.signer.signAndBroadcast(createTx);
    const address = await this.base.getNewComponent(createReceipt);
    allReceipts.push(createReceipt);

    const deployedArtifact: ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
    // ValidatorAnnounce has no mutable state - mailbox address is set at creation
    return [];
  }
}
