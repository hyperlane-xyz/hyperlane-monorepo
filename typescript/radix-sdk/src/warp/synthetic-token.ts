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
  RawSyntheticWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getSyntheticWarpTokenConfig } from './warp-query.js';
import {
  getCreateSyntheticTokenTx,
  getEnrollRemoteRouterTx,
  getSetTokenIsmTx,
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

export class RadixSyntheticTokenReader
  implements ArtifactReader<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    protected readonly gateway: GatewayApiClient,
    protected readonly base: RadixBase,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
  > {
    // Fetch token info
    const token = await getSyntheticWarpTokenConfig(
      this.gateway,
      this.base,
      address,
    );

    const config: RawSyntheticWarpArtifactConfig = {
      type: AltVM.TokenType.synthetic,
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

export class RadixSyntheticTokenWriter
  extends RadixSyntheticTokenReader
  implements ArtifactWriter<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    gateway: GatewayApiClient,
    private readonly signer: RadixBaseSigner,
    base: RadixBase,
  ) {
    super(gateway, base);
  }

  async create(
    artifact: ArtifactNew<RawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawSyntheticWarpArtifactConfig, DeployedWarpAddress>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    // Create the synthetic token
    const transactionManifest = await getCreateSyntheticTokenTx(
      this.base,
      this.signer.getAddress(),
      {
        mailbox: config.mailbox,
        name: config.name,
        symbol: config.symbol,
        divisibility: config.decimals,
      },
    );

    const createReceipt =
      await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(createReceipt);
    allReceipts.push(createReceipt);

    // Set ISM if configured
    if (config.interchainSecurityModule) {
      const ismAddress = config.interchainSecurityModule.deployed.address;
      const setIsmTx = await getSetTokenIsmTx(
        this.base,
        this.signer.getAddress(),
        {
          tokenAddress: address,
          ismAddress,
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

    // We don't transfer ownership here because after deployment the token needs to be
    // enrolled with the other tokens deployed and only the owner can

    const deployedArtifact: ArtifactDeployed<
      RawSyntheticWarpArtifactConfig,
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
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
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
