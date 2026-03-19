import {
  address as parseAddress,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { TestIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';

import { resolveProgram } from '../deploy/resolve-program.js';
import { getInitTestIsmInstruction } from '../instructions/test-ism.js';
import type { SvmSigner } from '../clients/signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
} from '../types.js';

import { fetchTestIsmStorageAccount } from './ism-query.js';

/**
 * Deployment-time configuration for the SVM test ISM writer.
 * Passed to the writer constructor; separate from the on-chain artifact config.
 */
export type SvmTestIsmWriterConfig = Readonly<{
  /** How to obtain the deployed program: fresh bytes or pre-existing ID. */
  program: SvmProgramTarget;
}>;

/** @deprecated Use SvmTestIsmWriterConfig instead. Kept for backward compat. */
export interface SvmTestIsmConfig extends TestIsmConfig {
  program: SvmProgramTarget;
}

export class SvmTestIsmReader implements ArtifactReader<
  TestIsmConfig,
  SvmDeployedIsm
> {
  constructor(protected readonly rpc: Rpc<SolanaRpcApi>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, SvmDeployedIsm>> {
    const programId = parseAddress(address);
    const storage = await fetchTestIsmStorageAccount(this.rpc, programId);
    if (storage === null) {
      throw new Error(`Test ISM not initialized at program: ${programId}`);
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: IsmType.TEST_ISM },
      deployed: { address: programId, programId },
    };
  }
}

export class SvmTestIsmWriter
  extends SvmTestIsmReader
  implements ArtifactWriter<TestIsmConfig, SvmDeployedIsm>
{
  constructor(
    private readonly writerConfig: SvmTestIsmWriterConfig,
    rpc: Rpc<SolanaRpcApi>,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    _artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<[ArtifactDeployed<TestIsmConfig, SvmDeployedIsm>, SvmReceipt[]]> {
    const { programAddress, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const storage = await fetchTestIsmStorageAccount(this.rpc, programAddress);
    if (storage === null) {
      const instruction = await getInitTestIsmInstruction(
        programAddress,
        this.svmSigner.signer,
      );
      const initReceipt = await this.svmSigner.send({
        instructions: [instruction],
        skipPreflight: true,
      });
      receipts.push(initReceipt);
    }

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TEST_ISM },
        deployed: { address: programAddress, programId: programAddress },
      },
      receipts,
    ];
  }

  async update(
    _artifact: ArtifactDeployed<TestIsmConfig, SvmDeployedIsm>,
  ): Promise<AnnotatedSvmTransaction[]> {
    return [];
  }
}
