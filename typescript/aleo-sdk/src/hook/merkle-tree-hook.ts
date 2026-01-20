import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { getNewContractExpectedNonce } from '../utils/base-query.js';
import {
  fromAleoAddress,
  getProgramIdFromSuffix,
  getProgramSuffix,
} from '../utils/helper.js';
import {
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getNewHookAddress } from './base.js';
import { getMerkleTreeHookConfig } from './hook-query.js';
import { getCreateMerkleTreeHookTx } from './hook-tx.js';

export class AleoMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    const hookConfig = await getMerkleTreeHookConfig(this.aleoClient, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.MERKLE_TREE,
      },
      deployed: {
        address: hookConfig.address,
      },
    };
  }
}

export class AleoMerkleTreeHookWriter
  extends AleoMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
    private readonly mailboxAddress: string,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>, AleoReceipt[]]
  > {
    const { programId } = fromAleoAddress(this.mailboxAddress);
    const suffix = getProgramSuffix(programId);
    const prefix = this.signer.getNetworkPrefix();

    const hookManagerProgramId = await this.signer.getHookManager(suffix);
    const dispatchProxyProgramId = getProgramIdFromSuffix(
      prefix,
      'dispatch_proxy',
      suffix,
    );

    const transaction = getCreateMerkleTreeHookTx(
      hookManagerProgramId,
      dispatchProxyProgramId,
    );

    const expectedNonce = await getNewContractExpectedNonce(
      this.aleoClient,
      hookManagerProgramId,
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const hookAddress = await getNewHookAddress(
      this.aleoClient,
      hookManagerProgramId,
      expectedNonce,
    );

    const deployedArtifact: ArtifactDeployed<
      MerkleTreeHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: hookAddress,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedAleoTransaction[]> {
    // MerkleTreeHook has no mutable state
    return [];
  }
}
