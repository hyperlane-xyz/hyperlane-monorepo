import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  OrchestratedArtifactReader,
  OrchestratedArtifactWriter,
  WithCompositionVariant,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedWarpAddress,
  RawSyntheticWarpArtifactConfig,
  computeRemoteRoutersUpdates,
} from '@hyperlane-xyz/provider-sdk/warp';
import { eqAddressRadix } from '@hyperlane-xyz/utils';

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

type OrchestratedRawSyntheticWarpArtifactConfig = WithCompositionVariant<
  RawSyntheticWarpArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

function withErrorContext(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}

export class RadixSyntheticTokenReader implements OrchestratedArtifactReader<
  RawSyntheticWarpArtifactConfig,
  DeployedWarpAddress
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(
    protected readonly gateway: GatewayApiClient,
    protected readonly base: RadixBase,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      OrchestratedRawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >
  > {
    // Fetch token info
    const token = await getSyntheticWarpTokenConfig(
      this.gateway,
      this.base,
      address,
    ).catch((error: unknown) => {
      throw withErrorContext(
        `Failed to read synthetic warp token config (address=${address})`,
        error,
      );
    });

    const config: OrchestratedRawSyntheticWarpArtifactConfig = {
      composition: ArtifactComposition.ORCHESTRATED,
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
  implements
    OrchestratedArtifactWriter<
      RawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >
{
  constructor(
    gateway: GatewayApiClient,
    private readonly signer: RadixBaseSigner,
    base: RadixBase,
  ) {
    super(gateway, base);
  }

  async create(
    artifact: ArtifactNew<OrchestratedRawSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        OrchestratedRawSyntheticWarpArtifactConfig,
        DeployedWarpAddress
      >,
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
    ).catch((error: unknown) => {
      throw withErrorContext(
        `Failed to build synthetic create transaction (signer=${this.signer.getAddress()}, mailbox=${config.mailbox}, name=${config.name}, symbol=${config.symbol})`,
        error,
      );
    });

    const createReceipt = await this.signer
      .signAndBroadcast(transactionManifest)
      .catch((error: unknown) => {
        throw withErrorContext(
          `Failed to create synthetic warp token (signer=${this.signer.getAddress()}, mailbox=${config.mailbox}, name=${config.name}, symbol=${config.symbol})`,
          error,
        );
      });
    const address = await this.base
      .getNewComponent(createReceipt)
      .catch((error: unknown) => {
        throw withErrorContext(
          'Failed to resolve created synthetic token address from transaction receipt',
          error,
        );
      });
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
      ).catch((error: unknown) => {
        throw withErrorContext(
          `Failed to build set ISM transaction for synthetic warp token ${address}`,
          error,
        );
      });

      const ismReceipt = await this.signer
        .signAndBroadcast(setIsmTx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed to set ISM for synthetic warp token ${address}`,
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
          `Failed to build enroll remote router transaction for synthetic warp token ${address} (domain=${domainId}, router=${routerAddress})`,
          error,
        );
      });

      const enrollReceipt = await this.signer
        .signAndBroadcast(enrollTx)
        .catch((error: unknown) => {
          throw withErrorContext(
            `Failed to enroll remote router for synthetic warp token ${address} (domain=${domainId}, router=${routerAddress})`,
            error,
          );
        });
      allReceipts.push(enrollReceipt);
    }

    // We don't transfer ownership here because after deployment the token needs to be
    // enrolled with the other tokens deployed and only the owner can perform that enrollment.

    const deployedArtifact: ArtifactDeployed<
      OrchestratedRawSyntheticWarpArtifactConfig,
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
      OrchestratedRawSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
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
