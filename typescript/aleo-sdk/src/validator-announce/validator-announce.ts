import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedValidatorAnnounceAddress,
  type RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';
import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { getMailboxConfig } from '../mailbox/mailbox-query.js';
import {
  SUFFIX_LENGTH_SHORT,
  fromAleoAddress,
  toAleoAddress,
} from '../utils/helper.js';
import {
  type AleoNetworkId,
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getValidatorAnnounceConfig } from './validator-announce-query.js';
import { getCreateValidatorAnnounceTx } from './validator-announce-tx.js';

/**
 * Reader for Aleo ValidatorAnnounce.
 * Reads deployed validator announce configuration from the chain.
 */
export class AleoValidatorAnnounceReader
  implements
    ArtifactReader<RawValidatorAnnounceConfig, DeployedValidatorAnnounceAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >
  > {
    const validatorAnnounceConfig = await getValidatorAnnounceConfig(
      this.aleoClient,
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

/**
 * Writer for Aleo ValidatorAnnounce.
 * Handles deployment. ValidatorAnnounce is immutable after deployment.
 */
export class AleoValidatorAnnounceWriter
  extends AleoValidatorAnnounceReader
  implements
    ArtifactWriter<RawValidatorAnnounceConfig, DeployedValidatorAnnounceAddress>
{
  constructor(
    private readonly aleoNetworkId: AleoNetworkId,
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<RawValidatorAnnounceConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        RawValidatorAnnounceConfig,
        DeployedValidatorAnnounceAddress
      >,
      AleoReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: AleoReceipt[] = [];

    // 1. Deploy validator_announce program
    const validatorAnnounceSuffix =
      this.signer.generateSuffix(SUFFIX_LENGTH_SHORT);
    const programs = await this.signer.deployProgram(
      'validator_announce',
      validatorAnnounceSuffix,
    );

    const validatorAnnounceProgramId = programs['validator_announce'];
    assert(
      validatorAnnounceProgramId,
      'validator announce program not deployed',
    );

    // 2. Query mailbox for localDomain
    const mailboxConfig = await getMailboxConfig(
      this.aleoClient,
      config.mailboxAddress,
      this.aleoNetworkId,
    );

    // 3. Initialize validator announce with mailbox address and local domain
    const { address: mailboxPlainAddress } = fromAleoAddress(
      config.mailboxAddress,
    );
    const createTx = getCreateValidatorAnnounceTx(
      validatorAnnounceProgramId,
      mailboxPlainAddress,
      mailboxConfig.localDomain,
    );

    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    allReceipts.push(createReceipt);

    const validatorAnnounceAddress = toAleoAddress(validatorAnnounceProgramId);

    const deployedArtifact: ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: validatorAnnounceAddress,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >,
  ): Promise<AnnotatedAleoTransaction[]> {
    // ValidatorAnnounce has no mutable state - mailbox address is set at creation
    return [];
  }
}
