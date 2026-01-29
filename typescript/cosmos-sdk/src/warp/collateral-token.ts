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
  type RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import {
  type CosmosWarpQueryClient,
  getCollateralWarpTokenConfig,
} from './warp-query.js';
import {
  getCreateCollateralTokenTx,
  getEnrollRemoteRouterTx,
  getSetTokenIsmTx,
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

export class CosmosCollateralTokenReader
  implements
    ArtifactReader<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(protected readonly query: CosmosWarpQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const tokenConfig = await getCollateralWarpTokenConfig(this.query, address);

    const config: RawCollateralWarpArtifactConfig = {
      type: AltVM.TokenType.collateral,
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
      token: tokenConfig.token,
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

export class CosmosCollateralTokenWriter
  extends CosmosCollateralTokenReader
  implements
    ArtifactWriter<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    query: CosmosWarpQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<RawCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>,
      DeliverTxResponse[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: DeliverTxResponse[] = [];

    // Create collateral token
    const createTx = getCreateCollateralTokenTx(
      this.signer.getSignerAddress(),
      {
        mailboxAddress: config.mailbox,
        collateralDenom: config.token,
      },
    );

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
      RawCollateralWarpArtifactConfig,
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
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedEncodeObject[]> {
    // Read current state from chain
    const currentArtifact = await this.read(artifact.deployed.address);

    // Generate update transactions
    return getWarpTokenUpdateTxs(
      artifact,
      currentArtifact,
      this.signer.getSignerAddress(),
    );
  }
}
