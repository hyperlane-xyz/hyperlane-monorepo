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
  computeRemoteRoutersUpdates,
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
  getWarpTokenUpdateTxs,
} from './warp-tx.js';

function withErrorContext(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}

export class RadixCollateralTokenReader implements ArtifactReader<
  RawCollateralWarpArtifactConfig,
  DeployedWarpAddress
> {
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
    ).catch((error: unknown) => {
      throw withErrorContext(
        `Failed to read collateral warp token config (address=${address})`,
        error,
      );
    });

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
    ).catch((error: unknown) => {
      throw withErrorContext(
        `Failed to build collateral create transaction (signer=${this.signer.getAddress()}, mailbox=${config.mailbox}, originDenom=${config.token})`,
        error,
      );
    });

    const createReceipt = await this.signer
      .signAndBroadcast(transactionManifest)
      .catch((error: unknown) => {
        throw withErrorContext(
          `Failed to create collateral warp token (signer=${this.signer.getAddress()}, mailbox=${config.mailbox}, originDenom=${config.token})`,
          error,
        );
      });
    const address = await this.base
      .getNewComponent(createReceipt)
      .catch((error: unknown) => {
        throw withErrorContext(
          'Failed to resolve created collateral token address from transaction receipt',
          error,
        );
      });
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
      ).catch((error: unknown) => {
        throw withErrorContext(
          `Failed to build set ISM transaction for collateral warp token ${address}`,
          error,
        );
      });

      const ismReceipt = await this.signer
        .signAndBroadcast(setIsmTx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed to set ISM for collateral warp token ${address}`,
            error,
          );
        });
      allReceipts.push(ismReceipt);
    }

    const { toEnroll } = computeRemoteRoutersUpdates(
      { destinationGas: {}, remoteRouters: {} },
      config,
      eqAddressRadix,
    );

    // Enroll remote routers
    for (const { domainId, gas, routerAddress } of toEnroll) {
      const enrollTx = await getEnrollRemoteRouterTx(
        this.base,
        this.signer.getAddress(),
        {
          tokenAddress: address,
          remoteDomainId: domainId,
          remoteRouterAddress: routerAddress,
          destinationGas: gas,
        },
      ).catch((error: unknown) => {
        throw withErrorContext(
          `Failed to build enroll remote router transaction for collateral warp token ${address} (domain=${domainId}, router=${routerAddress})`,
          error,
        );
      });

      const enrollReceipt = await this.signer
        .signAndBroadcast(enrollTx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed to enroll remote router for collateral warp token ${address} (domain=${domainId}, router=${routerAddress})`,
            error,
          );
        });
      allReceipts.push(enrollReceipt);
    }

    // We don't transfer ownership here because after deployment the token needs to be
    // enrolled with the other tokens deployed and only the owner can perform that enrollment.

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
      // The current owner is the only one that can execute the update transactions
      currentArtifactState.config.owner,
    );
  }
}
