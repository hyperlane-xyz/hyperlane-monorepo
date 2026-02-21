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
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { getInitTestIsmInstruction } from '../instructions/test-ism.js';
import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmReceipt } from '../types.js';

import { fetchTestIsmStorageAccount } from './ism-query.js';

export class SvmTestIsmReader implements ArtifactReader<
  TestIsmConfig,
  DeployedIsmAddress
> {
  constructor(
    protected readonly rpc: Rpc<SolanaRpcApi>,
    protected readonly programId: Address,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    const programId = address as Address;
    const storage = await fetchTestIsmStorageAccount(this.rpc, programId);
    if (storage === null) {
      throw new Error(`Test ISM not initialized at program: ${programId}`);
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: IsmType.TEST_ISM as 'testIsm' },
      deployed: { address: programId },
    };
  }
}

export class SvmTestIsmWriter
  extends SvmTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    programId: Address,
    private readonly svmSigner: SvmSigner,
  ) {
    super(rpc, programId);
  }

  async create(
    _artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, SvmReceipt[]]
  > {
    const instruction = await getInitTestIsmInstruction(
      this.programId,
      this.svmSigner.signer,
    );

    const receipt = await this.svmSigner.send({ instructions: [instruction] });

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: IsmType.TEST_ISM as 'testIsm' },
        deployed: { address: this.programId },
      },
      [receipt],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    return [];
  }
}
