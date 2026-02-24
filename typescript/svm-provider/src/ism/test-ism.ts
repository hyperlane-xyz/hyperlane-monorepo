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
import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedIsm,
  SvmProgramTarget,
  SvmReceipt,
} from '../types.js';

import { fetchTestIsmStorageAccount } from './ism-query.js';

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
      config: { type: IsmType.TEST_ISM as 'testIsm' },
      deployed: { address: programId, programId },
    };
  }
}

export class SvmTestIsmWriter
  extends SvmTestIsmReader
  implements ArtifactWriter<TestIsmConfig, SvmDeployedIsm>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<[ArtifactDeployed<TestIsmConfig, SvmDeployedIsm>, SvmReceipt[]]> {
    const config = artifact.config as SvmTestIsmConfig;
    const { programAddress, receipts } = await resolveProgram(
      config.program,
      this.svmSigner,
      this.rpc,
    );

    const instruction = await getInitTestIsmInstruction(
      programAddress,
      this.svmSigner.signer,
    );

    const initReceipt = await this.svmSigner.send({
      instructions: [instruction],
    });

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TEST_ISM as 'testIsm' },
        deployed: { address: programAddress, programId: programAddress },
      },
      [...receipts, initReceipt],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<TestIsmConfig, SvmDeployedIsm>,
  ): Promise<AnnotatedSvmTransaction[]> {
    return [];
  }
}
