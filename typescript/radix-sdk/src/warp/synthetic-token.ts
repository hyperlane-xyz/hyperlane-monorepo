import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  ConfigOnChain,
  WithCompositionVariant,
  isArtifactDeployed,
  isArtifactUnderived,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  DeployedWarpAddress,
  RawSyntheticWarpArtifactConfig,
  SyntheticWarpArtifactConfig,
  computeRemoteRoutersUpdates,
} from '@hyperlane-xyz/provider-sdk/warp';
import { assert, eqAddressRadix } from '@hyperlane-xyz/utils';

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

type OrchestratedSyntheticWarpArtifactConfig = WithCompositionVariant<
  SyntheticWarpArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

/**
 * Post-deploy on-chain shape: composite ISM/hook/fee children collapse to
 * `ArtifactOnChain<>` via `ConfigOnChain`. Returned from `read()` /
 * `create()` per the orchestrated `ArtifactReader` / `ArtifactWriter`
 * contract.
 */
type OrchestratedSyntheticWarpArtifactOnChain = ConfigOnChain<
  OrchestratedSyntheticWarpArtifactConfig,
  DeployedWarpAddress
>;

function withErrorContext(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${message}`);
}

export class RadixSyntheticTokenReader implements ArtifactReader<
  SyntheticWarpArtifactConfig,
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
      OrchestratedSyntheticWarpArtifactOnChain,
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

    const config: OrchestratedSyntheticWarpArtifactOnChain = {
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
  implements ArtifactWriter<SyntheticWarpArtifactConfig, DeployedWarpAddress>
{
  constructor(
    gateway: GatewayApiClient,
    private readonly signer: RadixBaseSigner,
    base: RadixBase,
  ) {
    super(gateway, base);
  }

  async create(
    artifact: ArtifactNew<OrchestratedSyntheticWarpArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        OrchestratedSyntheticWarpArtifactOnChain,
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
      const ismArtifact = config.interchainSecurityModule;
      assert(
        isArtifactDeployed(ismArtifact) || isArtifactUnderived(ismArtifact),
        `Synthetic warp create: ISM child must be resolved on-chain (DEPLOYED or UNDERIVED) before being passed to the raw writer; got artifactState=${ismArtifact.artifactState ?? 'new'}`,
      );
      const ismAddress = ismArtifact.deployed.address;
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
      OrchestratedSyntheticWarpArtifactOnChain,
      DeployedWarpAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      // CAST: ISM/hook/fee children were asserted to be DEPLOYED /
      // UNDERIVED above; both are valid `ArtifactOnChain` positions.
      // Bridge the pre-collapse `Artifact<>` union to the post-collapse
      // `ArtifactOnChain<>` shape — TS can't reduce the generic mapped
      // type at indexing time.
      config: artifact.config as OrchestratedSyntheticWarpArtifactOnChain,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<
      OrchestratedSyntheticWarpArtifactConfig,
      DeployedWarpAddress
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
    const currentArtifactState = await this.read(artifact.deployed.address);

    // CAST: pre-collapse `OrchestratedSyntheticWarpArtifactConfig` and
    // post-collapse `OrchestratedSyntheticWarpArtifactOnChain` are
    // structurally identical at runtime when ISM/hook/fee children have
    // been resolved by the caller (the deploy-sdk does this before
    // invoking the raw writer). `getWarpTokenUpdateTxs` is typed against
    // `RawWarpArtifactConfig` (post-collapse) and accesses children via
    // `?.deployed.address`. Bridge the two equivalent shapes.
    return getWarpTokenUpdateTxs(
      artifact as ArtifactDeployed<
        RawSyntheticWarpArtifactConfig,
        DeployedWarpAddress
      >,
      currentArtifactState as ArtifactDeployed<
        RawSyntheticWarpArtifactConfig,
        DeployedWarpAddress
      >,
      this.base,
      this.gateway,
      // The current owner is the only one that can execute the update transactions
      currentArtifactState.config.owner,
    );
  }
}
