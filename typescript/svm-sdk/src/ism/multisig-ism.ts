import { address as parseAddress, type Address } from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { MultisigIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import { assert } from '@hyperlane-xyz/utils';

import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitializeMultisigIsmMessageIdInstruction,
  getSetValidatorsAndThresholdInstruction,
} from '../instructions/multisig-ism-message-id.js';
import type { SvmSigner } from '../clients/signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
  SvmRpc,
  SvmTransaction,
} from '../types.js';

import {
  fetchMultisigIsmAccessControl,
  fetchMultisigIsmDomainData,
  validatorBytesToHex,
} from './ism-query.js';

const CHUNK_SIZE = 5;

export interface SvmMultisigIsmConfig extends MultisigIsmConfig {
  program: SvmProgramTarget;
  domains?: Record<number, { validators: string[]; threshold: number }>;
}

export class SvmMessageIdMultisigIsmReader implements ArtifactReader<
  MultisigIsmConfig,
  SvmDeployedIsm
> {
  constructor(protected readonly rpc: SvmRpc) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, SvmDeployedIsm>> {
    const programId = parseAddress(address);
    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      programId,
    );
    if (accessControl === null) {
      throw new Error(`Multisig ISM not initialized at program: ${programId}`);
    }

    // TODO: The SVM multisig ISM stores validators/threshold per-domain rather
    // than globally. Proper reading will be added in a future PR.
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: [],
        threshold: 0,
      },
      deployed: { address: programId, programId },
    };
  }

  async readDomain(
    programId: Address,
    domain: number,
  ): Promise<{ validators: string[]; threshold: number } | null> {
    const domainData = await fetchMultisigIsmDomainData(
      this.rpc,
      programId,
      domain,
    );
    if (domainData === null) return null;
    return {
      validators: validatorBytesToHex(
        domainData.validatorsAndThreshold.validators,
      ),
      threshold: domainData.validatorsAndThreshold.threshold,
    };
  }
}

export class SvmMessageIdMultisigIsmWriter
  extends SvmMessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, SvmDeployedIsm>
{
  constructor(
    rpc: SvmRpc,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, SvmDeployedIsm>, SvmReceipt[]]
  > {
    const config = artifact.config as SvmMultisigIsmConfig;
    const { programAddress, receipts } = await resolveProgram(
      config.program,
      this.svmSigner,
      this.rpc,
    );

    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      programAddress,
    );

    if (accessControl === null) {
      const initIx = await getInitializeMultisigIsmMessageIdInstruction(
        programAddress,
        this.svmSigner.signer,
      );
      const initReceipt = await this.svmSigner.send({
        instructions: [initIx],
      });
      receipts.push(initReceipt);
    }

    if (config.domains) {
      const domainInstructions = await Promise.all(
        Object.entries(config.domains).map(
          async ([domainStr, domainConfig]) => {
            const domain = Number(domainStr);
            assert(
              Number.isInteger(domain) && domain >= 0,
              `Invalid domain: '${domainStr}'`,
            );
            return getSetValidatorsAndThresholdInstruction({
              programAddress,
              owner: this.svmSigner.signer,
              domain,
              validators: domainConfig.validators,
              threshold: domainConfig.threshold,
            });
          },
        ),
      );

      for (let i = 0; i < domainInstructions.length; i += CHUNK_SIZE) {
        const chunk = domainInstructions.slice(i, i + CHUNK_SIZE);
        const tx: SvmTransaction = { instructions: chunk };
        const receipt = await this.svmSigner.send(tx);
        receipts.push(receipt);
      }
    } else if (config.validators.length > 0) {
      throw new Error(
        'Single validators/threshold config not supported on Solana. Use domains map.',
      );
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: config,
        deployed: { address: programAddress, programId: programAddress },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<MultisigIsmConfig, SvmDeployedIsm>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const programId = artifact.deployed.programId;
    return this.getUpdateDomainTxs(artifact, programId);
  }

  // TODO: The SVM multisig ISM requires per-domain diffing to compute updates.
  // Proper update logic will be added in a future PR.
  private async getUpdateDomainTxs(
    _artifact: ArtifactDeployed<MultisigIsmConfig, SvmDeployedIsm>,
    _programId: Address,
  ): Promise<AnnotatedSvmTransaction[]> {
    return [];
  }

  async getUpdateDomainTx(
    programId: Address,
    domain: number,
    validators: string[],
    threshold: number,
  ): Promise<AnnotatedSvmTransaction> {
    const ix = await getSetValidatorsAndThresholdInstruction({
      programAddress: programId,
      owner: this.svmSigner.signer,
      domain,
      validators,
      threshold,
    });

    return {
      feePayer: this.svmSigner.signer.address,
      instructions: [ix],
      annotation: `Set validators for domain ${domain}`,
    };
  }
}
