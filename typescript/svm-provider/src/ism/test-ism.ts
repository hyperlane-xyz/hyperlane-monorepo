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

import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmReceipt } from '../types.js';

import { fetchTestIsmStorageAccount } from './ism-query.js';
import { getSetTestIsmAcceptInstruction } from './ism-tx.js';

/**
 * Reader for SVM Test ISM.
 *
 * On Solana, the Test ISM is a simple program that always accepts messages
 * (when accept=true) or always rejects them (when accept=false).
 *
 * The "address" is the program ID, not a PDA.
 */
export class SvmTestIsmReader
  implements ArtifactReader<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly programId: Address,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>> {
    // On Solana, address is the program ID
    const programId = address as Address;

    // Verify the program is initialized by checking storage PDA
    const storage = await fetchTestIsmStorageAccount(this.rpc, programId);
    if (storage === null) {
      throw new Error(`Test ISM not initialized at program: ${programId}`);
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.TEST_ISM as 'testIsm',
      },
      deployed: {
        address: programId,
      },
    };
  }
}

/**
 * Writer for SVM Test ISM.
 *
 * Handles initialization of test ISMs which accept all messages without verification.
 *
 * Note: On Solana, the program must be deployed separately. This writer only
 * initializes the program's state (sets accept=true).
 */
export class SvmTestIsmWriter
  extends SvmTestIsmReader
  implements ArtifactWriter<TestIsmConfig, DeployedIsmAddress>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    programId: Address,
    private readonly signer: SvmSigner,
  ) {
    super(rpc, programId);
  }

  async create(
    _artifact: ArtifactNew<TestIsmConfig>,
  ): Promise<
    [ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>, SvmReceipt[]]
  > {
    // Initialize Test ISM by setting accept=true
    const instruction = await getSetTestIsmAcceptInstruction({
      programId: this['programId'],
      accept: true,
    });

    const receipt = await this.signer.signAndSend(this['rpc'], {
      instructions: [instruction],
    });

    const deployedArtifact: ArtifactDeployed<
      TestIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.TEST_ISM as 'testIsm',
      },
      deployed: {
        address: this['programId'],
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<TestIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    // Test ISM has no mutable state (accept is set during init)
    return [];
  }
}
