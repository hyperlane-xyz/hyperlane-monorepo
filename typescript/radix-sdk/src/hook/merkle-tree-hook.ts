import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddresses,
  MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getMerkleTreeHookConfig } from './hook-query.js';
import { getCreateMerkleTreeHookTx } from './hook-tx.js';

export class RadixMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddresses>
{
  constructor(private readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddresses>> {
    const hookConfig = await getMerkleTreeHookConfig(this.gateway, address);

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

export class RadixMerkleTreeHookWriter
  extends RadixMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddresses>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
    private readonly mailboxAddress: string,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddresses>, TxReceipt[]]
  > {
    const transactionManifest = await getCreateMerkleTreeHookTx(
      this.base,
      this.signer.getAddress(),
      this.mailboxAddress,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(receipt);

    const deployedArtifact: ArtifactDeployed<
      MerkleTreeHookConfig,
      DeployedHookAddresses
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddresses>,
  ): Promise<AnnotatedRadixTransaction[]> {
    // MerkleTreeHook has no mutable state
    return [];
  }
}
