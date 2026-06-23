import { type DeliverTxResponse } from '@cosmjs/stargate';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactComposition,
  ArtifactState,
  type WithCompositionVariant,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawSyntheticWarpArtifactConfig,
  computeRemoteRoutersUpdates,
} from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressCosmos } from '@hyperlane-xyz/utils';

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

type OrchestratedRawSyntheticWarpArtifactConfig = WithCompositionVariant<
  RawSyntheticWarpArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

export class CosmosSyntheticTokenReader implements ArtifactReader<
  RawSyntheticWarpArtifactConfig,
  DeployedWarpAddress
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(protected readonly query: CosmosWarpQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      OrchestratedRawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >
  > {
    const tokenConfig = await getSyntheticWarpTokenConfig(this.query, address);

    const config: OrchestratedRawSyntheticWarpArtifactConfig = {
      composition: ArtifactComposition.ORCHESTRATED,
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
    artifact: ArtifactNew<OrchestratedRawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        OrchestratedRawSyntheticWarpArtifactConfig,
        DeployedWarpAddress
      >,
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
    const { toEnroll } = computeRemoteRoutersUpdates(
      { destinationGas: {}, remoteRouters: {} },
      config,
      eqAddressCosmos,
    );

    for (const { domainId, gas, routerAddress } of toEnroll) {
      const enrollTx = getEnrollRemoteRouterTx(this.signer.getSignerAddress(), {
        tokenAddress,
        remoteDomainId: domainId,
        remoteRouterAddress: routerAddress,
        gas,
      });

      const enrollReceipt =
        await this.signer.sendAndConfirmTransaction(enrollTx);
      allReceipts.push(enrollReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      OrchestratedRawSyntheticWarpArtifactConfig,
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
      OrchestratedRawSyntheticWarpArtifactConfig,
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
