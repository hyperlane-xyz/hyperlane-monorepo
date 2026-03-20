import { address as parseAddress } from '@solana/kit';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedValidatorAnnounceAddress,
  RawValidatorAnnounceConfig,
} from '@hyperlane-xyz/provider-sdk/validator-announce';
import { assert, eqAddressSol, isNullish } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import { fetchValidatorAnnounceAccount } from './validator-announce-query.js';
import { buildInitValidatorAnnounceInstruction } from './validator-announce-tx.js';
import { DEFAULT_COMPUTE_UNITS } from '../constants.js';
import type { SvmValidatorAnnounceConfig } from './types.js';

export class SvmValidatorAnnounceReader implements ArtifactReader<
  RawValidatorAnnounceConfig,
  DeployedValidatorAnnounceAddress
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >
  > {
    const programId = parseAddress(address);

    const account = await fetchValidatorAnnounceAccount(this.rpc, programId);
    assert(account, `Validator announce not initialized at ${programId}`);

    const config: RawValidatorAnnounceConfig = {
      mailboxAddress: account.mailbox,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: { address: programId },
    };
  }
}

export class SvmValidatorAnnounceWriter
  extends SvmValidatorAnnounceReader
  implements
    ArtifactWriter<RawValidatorAnnounceConfig, DeployedValidatorAnnounceAddress>
{
  constructor(
    private readonly config: SvmValidatorAnnounceConfig,
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<RawValidatorAnnounceConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        RawValidatorAnnounceConfig,
        DeployedValidatorAnnounceAddress
      >,
      SvmReceipt[],
    ]
  > {
    const receipts: SvmReceipt[] = [];

    const { programAddress, receipts: deployReceipts } = await resolveProgram(
      this.config.program,
      this.svmSigner,
      this.rpc,
    );
    receipts.push(...deployReceipts);

    const existing = await fetchValidatorAnnounceAccount(
      this.rpc,
      programAddress,
    );
    const deployed: ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: { address: programAddress },
    };

    if (!isNullish(existing)) {
      assert(
        eqAddressSol(existing.mailbox, artifact.config.mailboxAddress),
        `Validator announce ${programAddress} already initialized with mailbox ${existing.mailbox}, expected ${artifact.config.mailboxAddress}`,
      );
      return [deployed, receipts];
    }

    const initIx = await buildInitValidatorAnnounceInstruction(
      programAddress,
      this.svmSigner.signer,
      {
        mailbox: parseAddress(artifact.config.mailboxAddress),
        localDomain: this.config.domainId,
      },
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        computeUnits: DEFAULT_COMPUTE_UNITS,
        skipPreflight: true,
      }),
    );

    return [deployed, receipts];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawValidatorAnnounceConfig,
      DeployedValidatorAnnounceAddress
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    // Validator announce has no mutable config fields after init.
    return [];
  }
}
