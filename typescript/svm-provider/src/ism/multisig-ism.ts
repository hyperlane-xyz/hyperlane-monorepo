import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedIsmAddress,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmReceipt,
  SvmTransaction,
} from '../types.js';

import {
  fetchMultisigIsmAccessControl,
  fetchMultisigIsmDomainData,
  validatorBytesToHex,
} from './ism-query.js';
import {
  getInitMultisigIsmInstruction,
  getSetValidatorsAndThresholdIx,
} from './ism-tx.js';

/**
 * Chunk size for batching setValidatorsAndThreshold instructions.
 * Matches Rust CLI CHUNK_SIZE constant.
 */
const CHUNK_SIZE = 5;

/**
 * Extended MultisigIsmConfig for Solana that includes per-domain configuration.
 *
 * On Solana, the multisig ISM stores validators per-domain in separate PDAs.
 * This differs from EVM where a single ISM has one set of validators.
 */
export interface SvmMultisigIsmConfig extends MultisigIsmConfig {
  /**
   * Per-domain validator configurations.
   * Key: domain ID
   * Value: { validators: string[], threshold: number }
   */
  domains?: Record<number, { validators: string[]; threshold: number }>;
}

/**
 * Reader for SVM Message ID Multisig ISM.
 *
 * On Solana, the multisig ISM stores:
 * - Access control in a single PDA (owner)
 * - Validators/threshold per domain in separate PDAs
 *
 * The "address" is the program ID.
 */
export class SvmMessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly programId: Address,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
    const programId = address as Address;

    // Verify the program is initialized
    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      programId,
    );
    if (accessControl === null) {
      throw new Error(`Multisig ISM not initialized at program: ${programId}`);
    }

    // Note: We can't enumerate all configured domains from on-chain data.
    // The caller must know which domains to query. For now, return empty config.
    // Full domain enumeration would require off-chain indexing.
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MESSAGE_ID_MULTISIG as 'messageIdMultisigIsm',
        validators: [],
        threshold: 0,
      },
      deployed: {
        address: programId,
      },
    };
  }

  /**
   * Read validators and threshold for a specific domain.
   */
  async readDomain(
    domain: number,
  ): Promise<{ validators: string[]; threshold: number } | null> {
    const domainData = await fetchMultisigIsmDomainData(
      this.rpc,
      this.programId,
      domain,
    );

    if (domainData === null) {
      return null;
    }

    return {
      validators: validatorBytesToHex(
        domainData.validatorsAndThreshold.validators as Uint8Array[],
      ),
      threshold: domainData.validatorsAndThreshold.threshold,
    };
  }
}

/**
 * Writer for SVM Message ID Multisig ISM.
 *
 * Handles:
 * 1. Initialization of access control (sets owner)
 * 2. Setting validators and threshold per domain
 *
 * Note: On Solana, the program must be deployed separately. This writer
 * initializes the program's state and configures validators.
 */
export class SvmMessageIdMultisigIsmWriter
  extends SvmMessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    programId: Address,
    private readonly signer: SvmSigner,
  ) {
    super(rpc, programId);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, SvmReceipt[]]
  > {
    const receipts: SvmReceipt[] = [];
    const config = artifact.config as SvmMultisigIsmConfig;

    // Check if already initialized
    const accessControl = await fetchMultisigIsmAccessControl(
      this.rpc,
      this.programId,
    );

    if (accessControl === null) {
      // Initialize access control
      const initIx = await getInitMultisigIsmInstruction({
        payer: this.signer.keypair,
        programId: this.programId,
      });

      const initReceipt = await this.signer.signAndSend(this.rpc, {
        instructions: [initIx],
      });
      receipts.push(initReceipt);
    }

    // Set validators for each domain
    if (config.domains) {
      const domainInstructions = await Promise.all(
        Object.entries(config.domains).map(
          async ([domainStr, domainConfig]) => {
            const domain = parseInt(domainStr);
            return getSetValidatorsAndThresholdIx({
              owner: this.signer.keypair,
              programId: this.programId,
              domain,
              validators: domainConfig.validators,
              threshold: domainConfig.threshold,
            });
          },
        ),
      );

      // Batch instructions in chunks (matching Rust CLI pattern)
      for (let i = 0; i < domainInstructions.length; i += CHUNK_SIZE) {
        const chunk = domainInstructions.slice(i, i + CHUNK_SIZE);
        const tx: SvmTransaction = { instructions: chunk };
        const receipt = await this.signer.signAndSend(this.rpc, tx);
        receipts.push(receipt);
      }
    } else if (config.validators.length > 0) {
      // Legacy single-domain config: apply to all domains via a single call
      // This is a simplification - in practice, caller should use domains map
      throw new Error(
        'Single validators/threshold config not supported on Solana. Use domains map.',
      );
    }

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: config,
      deployed: {
        address: this.programId,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    // Solana multisig ISM is effectively immutable.
    // To change validators, deploy a new program or reconfigure domains.
    // For now, return empty - updates not supported.
    return [];
  }

  /**
   * Update validators for a specific domain.
   * Returns the transaction to execute.
   */
  async getUpdateDomainTx(
    domain: number,
    validators: string[],
    threshold: number,
  ): Promise<AnnotatedSvmTransaction> {
    const ix = await getSetValidatorsAndThresholdIx({
      owner: this.signer.keypair,
      programId: this.programId,
      domain,
      validators,
      threshold,
    });

    return {
      instructions: [ix],
      annotation: `Set validators for domain ${domain}`,
    };
  }
}
