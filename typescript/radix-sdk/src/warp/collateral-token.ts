import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedWarpAddress,
  RawCollateralWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getCollateralWarpTokenConfig } from './warp-query.js';
import {
  getCreateCollateralTokenTx,
  getEnrollRemoteRouterTx,
  getSetTokenIsmTx,
  getSetTokenOwnerTx,
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

export class RadixCollateralTokenReader
  implements
    ArtifactReader<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly gateway: GatewayApiClient,
    protected readonly base: RadixBase,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
  > {
    // Fetch token info
    const token = await getCollateralWarpTokenConfig(
      this.gateway,
      this.base,
      address,
    );

    const config: RawCollateralWarpArtifactConfig = {
      type: AltVM.TokenType.collateral,
      owner: token.owner,
      mailbox: token.mailbox,
      interchainSecurityModule: token.interchainSecurityModule
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: token.interchainSecurityModule,
            },
          }
        : undefined,
      remoteRouters: token.remoteRouters,
      destinationGas: token.destinationGas,
      token: token.token,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
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

export class RadixCollateralTokenWriter
  extends RadixCollateralTokenReader
  implements
    ArtifactWriter<RawCollateralWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    gateway: GatewayApiClient,
    private readonly signer: RadixBaseSigner,
    base: RadixBase,
  ) {
    super(gateway, base);
  }

  async create(
    artifact: ArtifactNew<RawCollateralWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawCollateralWarpArtifactConfig, DeployedWarpAddress>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    // Create the collateral token
    const transactionManifest = await getCreateCollateralTokenTx(
      this.base,
      this.signer.getAddress(),
      {
        mailbox: config.mailbox,
        originDenom: config.token,
      },
    );

    const createReceipt =
      await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(createReceipt);
    allReceipts.push(createReceipt);

    // Set ISM if configured
    if (config.interchainSecurityModule) {
      const setIsmTx = await getSetTokenIsmTx(
        this.base,
        this.signer.getAddress(),
        {
          tokenAddress: address,
          ismAddress: config.interchainSecurityModule.deployed.address,
        },
      );

      const ismReceipt = await this.signer.signAndBroadcast(setIsmTx);
      allReceipts.push(ismReceipt);
    }

    // Enroll remote routers
    for (const [domainIdStr, remoteRouter] of Object.entries(
      config.remoteRouters,
    )) {
      const domainId = parseInt(domainIdStr);
      const gas = config.destinationGas[domainId] || '0';

      const enrollTx = await getEnrollRemoteRouterTx(
        this.base,
        this.signer.getAddress(),
        {
          tokenAddress: address,
          remoteDomainId: domainId,
          remoteRouterAddress: remoteRouter.address,
          destinationGas: gas,
        },
      );

      const enrollReceipt = await this.signer.signAndBroadcast(enrollTx);
      allReceipts.push(enrollReceipt);
    }

    // Transfer ownership if the configured owner is different from the signer
    if (!eqAddressRadix(this.signer.getAddress(), config.owner)) {
      const setOwnerTx = await getSetTokenOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          tokenAddress: address,
          newOwner: config.owner,
        },
      );

      const ownerReceipt = await this.signer.signAndBroadcast(setOwnerTx);
      allReceipts.push(ownerReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<
      RawCollateralWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
    // Read current state
    const currentArtifactState = await this.read(artifact.deployed.address);

    return getWarpTokenUpdateTxs(
      artifact,
      currentArtifactState,
      this.base,
      this.gateway,
      this.signer.getAddress(),
    );
  }
}
