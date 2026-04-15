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
  type RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { StarknetSigner } from '../clients/signer.js';
import { normalizeStarknetAddressSafe } from '../contracts.js';
import { getCreateMerkleTreeHookTx } from './hook-tx.js';

export class StarknetMerkleTreeHookReader implements ArtifactReader<
  RawHookArtifactConfigs['merkleTreeHook'],
  DeployedHookAddress
> {
  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >
  > {
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: AltVM.HookType.MERKLE_TREE },
      deployed: { address: normalizeStarknetAddressSafe(address) },
    };
  }
}

export class StarknetMerkleTreeHookWriter
  extends StarknetMerkleTreeHookReader
  implements
    ArtifactWriter<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >
{
  constructor(
    private readonly signer: StarknetSigner,
    private readonly mailboxAddress: string,
  ) {
    super();
  }

  async create(
    artifact: ArtifactNew<RawHookArtifactConfigs['merkleTreeHook']>,
  ): Promise<
    [
      ArtifactDeployed<
        RawHookArtifactConfigs['merkleTreeHook'],
        DeployedHookAddress
      >,
      TxReceipt[],
    ]
  > {
    const tx = getCreateMerkleTreeHookTx(
      this.signer.getSignerAddress(),
      this.mailboxAddress,
    );
    const receipt = await this.signer.sendAndConfirmTransaction(tx);
    const hookAddress = receipt.contractAddress;
    assert(hookAddress, 'failed to deploy Starknet merkle tree hook');

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: artifact.config,
        deployed: { address: hookAddress },
      },
      [receipt],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<
      RawHookArtifactConfigs['merkleTreeHook'],
      DeployedHookAddress
    >,
  ): Promise<AnnotatedTx[]> {
    return [];
  }
}
