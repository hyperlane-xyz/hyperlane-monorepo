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
import { assert, eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getWarpTokenConfig, getWarpTokenRemoteRouters } from './warp-query.js';
import {
  getCreateSyntheticTokenTx,
  getEnrollRemoteRouterTx,
  getSetTokenIsmTx,
  getSetTokenOwnerTx,
  getUnenrollRemoteRouterTx,
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
    const token = await getWarpTokenConfig(this.gateway, this.base, address);
    const remoteRoutersList = await getWarpTokenRemoteRouters(
      this.gateway,
      address,
    );

    // Map remote routers list to Record<number, { address: string }>
    const remoteRouters: Record<number, { address: string }> = {};
    const destinationGas: Record<number, string> = {};

    for (const router of remoteRoutersList) {
      remoteRouters[router.receiverDomainId] = {
        address: router.receiverAddress,
      };
      destinationGas[router.receiverDomainId] = router.gas;
    }

    const config: RawSyntheticWarpArtifactConfig = {
      type: AltVM.TokenType.synthetic,
      owner: token.owner,
      mailbox: token.mailboxAddress,
      interchainSecurityModule: token.ismAddress
        ? {
            artifactState: ArtifactState.UNDERIVED,
            deployed: {
              address: token.ismAddress,
            },
          }
        : undefined,
      remoteRouters,
      destinationGas,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
    };

    return {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: token.address,
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

    // Validate required fields for synthetic token
    assert(config.name, 'name is required for synthetic token deployment');
    assert(config.symbol, 'symbol is required for synthetic token deployment');
    assert(
      config.decimals !== undefined,
      'decimals is required for synthetic token deployment',
    );

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
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedRadixTransaction[] = [];

    // Read current state
    const currentState = await this.read(deployed.address);

    // Update ISM if changed
    const currentIsm =
      currentState.config.interchainSecurityModule?.deployed.address;
    const newIsm = config.interchainSecurityModule?.deployed.address;

    if (currentIsm !== newIsm) {
      const setIsmTx = await getSetTokenIsmTx(
        this.base,
        this.signer.getAddress(),
        {
          tokenAddress: deployed.address,
          ismAddress: newIsm || '',
        },
      );
      updateTxs.push({
        annotation: 'Updating token ISM',
        networkId: this.base.getNetworkId(),
        manifest: setIsmTx,
      });
    }

    // Get current and desired remote routers
    const currentRouters = new Set(
      Object.keys(currentState.config.remoteRouters).map((k) => parseInt(k)),
    );
    const desiredRouters = new Set(
      Object.keys(config.remoteRouters).map((k) => parseInt(k)),
    );

    // Unenroll removed routers
    for (const domainId of currentRouters) {
      if (!desiredRouters.has(domainId)) {
        const unenrollTx = await getUnenrollRemoteRouterTx(
          this.base,
          this.signer.getAddress(),
          {
            tokenAddress: deployed.address,
            remoteDomainId: domainId,
          },
        );
        updateTxs.push({
          annotation: `Unenrolling router for domain ${domainId}`,
          networkId: this.base.getNetworkId(),
          manifest: unenrollTx,
        });
      }
    }

    // Enroll or update routers
    for (const [domainIdStr, remoteRouter] of Object.entries(
      config.remoteRouters,
    )) {
      const domainId = parseInt(domainIdStr);
      const gas = config.destinationGas[domainId] || '0';
      const currentRouter = currentState.config.remoteRouters[domainId];
      const currentGas = currentState.config.destinationGas[domainId] || '0';

      const needsUpdate =
        !currentRouter ||
        currentRouter.address !== remoteRouter.address ||
        currentGas !== gas;

      if (needsUpdate) {
        const enrollTx = await getEnrollRemoteRouterTx(
          this.base,
          this.signer.getAddress(),
          {
            tokenAddress: deployed.address,
            remoteDomainId: domainId,
            remoteRouterAddress: remoteRouter.address,
            destinationGas: gas,
          },
        );
        updateTxs.push({
          annotation: `Enrolling/updating router for domain ${domainId}`,
          networkId: this.base.getNetworkId(),
          manifest: enrollTx,
        });
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!eqAddressRadix(currentState.config.owner, config.owner)) {
      const setOwnerTx = await getSetTokenOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          tokenAddress: deployed.address,
          newOwner: config.owner,
        },
      );
      updateTxs.push({
        annotation: 'Setting new token owner',
        networkId: this.base.getNetworkId(),
        manifest: setOwnerTx,
      });
    }

    return updateTxs;
  }
}
