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
  computeRemoteRoutersUpdates,
} from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressCosmos } from '@hyperlane-xyz/utils';

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

function withErrorContext(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}

export class CosmosCollateralTokenReader implements ArtifactReader<
  RawCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
  constructor(protected readonly query: CosmosWarpQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    const tokenConfig = await getCollateralWarpTokenConfig(
      this.query,
      address,
    ).catch((error: unknown) => {
      throw withErrorContext(
        `Failed to read collateral warp token config for ${address}`,
        error,
      );
    });

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
    const signerAddress = this.signer.getSignerAddress();

    // Create collateral token
    const createTx = getCreateCollateralTokenTx(signerAddress, {
      mailboxAddress: config.mailbox,
      collateralDenom: config.token,
    });

    const createReceipt = await this.signer
      .sendAndConfirmTransaction(createTx)
      .catch((error: unknown) => {
        throw withErrorContext(
          `Failed to create collateral warp token (mailbox=${config.mailbox}, token=${config.token}, signer=${signerAddress})`,
          error,
        );
      });
    allReceipts.push(createReceipt);

    // Get the deployed token address from the receipt
    const tokenAddress = getNewContractAddress(createReceipt);

    // Set ISM if provided
    if (config.interchainSecurityModule?.deployed.address) {
      const setIsmTx = getSetTokenIsmTx(signerAddress, {
        tokenAddress,
        ismAddress: config.interchainSecurityModule.deployed.address,
      });
      const ismReceipt = await this.signer
        .sendAndConfirmTransaction(setIsmTx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed to set ISM for collateral warp token ${tokenAddress} (ism=${config.interchainSecurityModule?.deployed.address}, signer=${signerAddress})`,
            error,
          );
        });
      allReceipts.push(ismReceipt);
    }

    // Enroll remote routers
    const { toEnroll } = computeRemoteRoutersUpdates(
      { destinationGas: {}, remoteRouters: {} },
      config,
      eqAddressCosmos,
    );

    for (const { domainId, gas, routerAddress } of toEnroll) {
      const enrollTx = getEnrollRemoteRouterTx(signerAddress, {
        tokenAddress,
        remoteDomainId: domainId,
        remoteRouterAddress: routerAddress,
        gas,
      });

      const enrollReceipt = await this.signer
        .sendAndConfirmTransaction(enrollTx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed to enroll remote router for collateral warp token ${tokenAddress} (domain=${domainId}, router=${routerAddress}, signer=${signerAddress})`,
            error,
          );
        });
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
      // The current owner is the only one that can execute the update transactions
      currentArtifact.config.owner,
    );
  }
}
