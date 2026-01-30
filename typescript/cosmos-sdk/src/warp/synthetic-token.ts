import { type DeliverTxResponse } from '@cosmjs/stargate';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawSyntheticWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import {
  type CosmosWarpQueryClient,
  getSyntheticWarpTokenConfig,
} from './warp-query.js';
import {
  getCreateSyntheticTokenTx,
  getEnrollRemoteRouterTx,
  getSetTokenIsmTx,
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

export class CosmosSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(protected readonly query: CosmosWarpQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    const tokenConfig = await getSyntheticWarpTokenConfig(this.query, address);

    const config: RawSyntheticWarpArtifactConfig = {
      type: AltVM.TokenType.synthetic,
      owner: tokenConfig.owner,
      mailbox: tokenConfig.mailbox,
      interchainSecurityModule: tokenConfig.interchainSecurityModule
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: tokenConfig.interchainSecurityModule,
            },
          }
        : undefined,
      remoteRouters: tokenConfig.remoteRouters,
      destinationGas: tokenConfig.destinationGas,
      name: tokenConfig.name,
      symbol: tokenConfig.symbol,
      decimals: tokenConfig.decimals,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address,
      },
    };
  }
}

export class CosmosSyntheticTokenWriter
  extends CosmosSyntheticTokenReader
  implements ArtifactWriter<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    query: CosmosWarpQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<RawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>,
      DeliverTxResponse[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: DeliverTxResponse[] = [];

    // Create synthetic token
    const createTx = getCreateSyntheticTokenTx(this.signer.getSignerAddress(), {
      mailboxAddress: config.mailbox,
    });

    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    allReceipts.push(createReceipt);

    // Get the deployed token address from the receipt
    const tokenAddress = getNewContractAddress(createReceipt);

    // Set ISM if provided
    if (config.interchainSecurityModule?.deployed.address) {
      const setIsmTx = getSetTokenIsmTx(this.signer.getSignerAddress(), {
        tokenAddress,
        ismAddress: config.interchainSecurityModule.deployed.address,
      });
      const ismReceipt = await this.signer.sendAndConfirmTransaction(setIsmTx);
      allReceipts.push(ismReceipt);
    }

    // Enroll remote routers
    for (const [domainIdStr, remoteRouter] of Object.entries(
      config.remoteRouters,
    )) {
      const domainId = parseInt(domainIdStr);
      const gas = config.destinationGas[domainId] || '0';

      const enrollTx = getEnrollRemoteRouterTx(this.signer.getSignerAddress(), {
        tokenAddress,
        remoteDomainId: domainId,
        remoteRouterAddress: remoteRouter.address,
        gas,
      });
      const enrollReceipt =
        await this.signer.sendAndConfirmTransaction(enrollTx);
      allReceipts.push(enrollReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: tokenAddress,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedEncodeObject[]> {
    // Read current state from chain
    const currentArtifact = await this.read(artifact.deployed.address);

    // Generate update transactions
    return getWarpTokenUpdateTxs(
      artifact,
      currentArtifact,
      // The current owner is the only one that can execute the update transactions
      currentArtifact.config.owner,
    );
  }
}
