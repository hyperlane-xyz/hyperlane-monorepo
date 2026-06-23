import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactComposition,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  ArtifactUnderived,
  ConfigOnChain,
  WithCompositionVariant,
  isArtifactDeployed,
  isArtifactUnderived,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  RoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { assert, eqAddressRadix, isNullish } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getDomainRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmDomainIsmTx,
  getSetRoutingIsmDomainIsmTx,
  getSetRoutingIsmOwnerTx,
} from './ism-tx.js';

type OrchestratedRoutingIsmArtifactConfig = WithCompositionVariant<
  RoutingIsmArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

/**
 * Post-deploy on-chain shape — ORCHESTRATED routing-ISM with children
 * collapsed via `ConfigOnChain`. Returned from `read()` / `create()` per the
 * orchestrated `ArtifactReader` / `ArtifactWriter` contract.
 */
type OrchestratedRoutingIsmOnChain = ConfigOnChain<
  OrchestratedRoutingIsmArtifactConfig,
  DeployedIsmAddress
>;

export class RadixRoutingIsmRawReader implements ArtifactReader<
  RoutingIsmArtifactConfig,
  DeployedIsmAddress
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<OrchestratedRoutingIsmOnChain, DeployedIsmAddress>
  > {
    const ismConfig = await getDomainRoutingIsmConfig(this.gateway, address);

    const domains: Record<number, ArtifactUnderived<DeployedIsmAddress>> = {};
    for (const route of ismConfig.routes) {
      domains[route.domainId] = {
        deployed: {
          address: route.ismAddress,
        },
        artifactState: ArtifactState.UNDERIVED,
      };
    }

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        composition: ArtifactComposition.ORCHESTRATED,
        type: IsmType.ROUTING,
        owner: ismConfig.owner,
        domains,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}

export class RadixRoutingIsmRawWriter
  extends RadixRoutingIsmRawReader
  implements ArtifactWriter<RoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<OrchestratedRoutingIsmArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<OrchestratedRoutingIsmOnChain, DeployedIsmAddress>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const receipts: TxReceipt[] = [];

    const routes = Object.entries(config.domains).map(([domainId, child]) => {
      assert(
        isArtifactDeployed(child) || isArtifactUnderived(child),
        `Routing ISM create: domain ${domainId} child must be resolved on-chain (DEPLOYED or UNDERIVED) before being passed to the raw writer; got artifactState=${child.artifactState ?? 'new'}`,
      );
      return {
        domainId: parseInt(domainId),
        ismAddress: child.deployed.address,
      };
    });

    const transactionManifest = await getCreateRoutingIsmTx(
      this.base,
      this.signer.getAddress(),
      routes,
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);
    receipts.push(receipt);
    const address = await this.base.getNewComponent(receipt);

    // Transfer ownership if config.owner differs from signer
    if (!eqAddressRadix(config.owner, this.signer.getAddress())) {
      const ownerTransferTx = await getSetRoutingIsmOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          ismAddress: address,
          newOwner: config.owner,
        },
      );

      const ownerReceipt = await this.signer.signAndBroadcast(ownerTransferTx);
      receipts.push(ownerReceipt);
    }

    const deployedArtifact: ArtifactDeployed<
      OrchestratedRoutingIsmOnChain,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      // CAST: the create input's children were asserted to be DEPLOYED /
      // UNDERIVED above; both are valid `ArtifactOnChain` positions.
      // Bridge the pre-collapse `Artifact<>` union to the post-collapse
      // `ArtifactOnChain<>` shape — TS can't reduce the mapped type.
      config: artifact.config as OrchestratedRoutingIsmOnChain,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<
      OrchestratedRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);

    const transactions: AnnotatedRadixTransaction[] = [];

    // This is the address that has to execute the update transactions
    const currentOwner = currentConfig.config.owner;

    // Find domains to add
    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? currentConfig.config.domains[domain].deployed.address
        : undefined;

      assert(
        isArtifactDeployed(expectedIsm) || isArtifactUnderived(expectedIsm),
        `Routing ISM update: domain ${domain} child must be resolved on-chain (DEPLOYED or UNDERIVED) before being passed to the raw writer; got artifactState=${expectedIsm.artifactState ?? 'new'}`,
      );
      const expectedIsmAddress = expectedIsm.deployed.address;

      if (
        isNullish(currentIsmAddress) ||
        !eqAddressRadix(currentIsmAddress, expectedIsmAddress)
      ) {
        const transactionManifest = await getSetRoutingIsmDomainIsmTx(
          this.base,
          currentOwner,
          {
            ismAddress: deployed.address,
            domainIsm: { domainId: domain, ismAddress: expectedIsmAddress },
          },
        );

        transactions.push({
          annotation: `Set ism for domain ${domain} to ISM ${expectedIsmAddress} on ${IsmType.ROUTING}`,
          networkId: this.base.getNetworkId(),
          manifest: transactionManifest,
        });
      }
    }

    // Find domains to remove
    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      const desiredIsmAddress = config.domains[domain];

      if (isNullish(desiredIsmAddress)) {
        const transactionManifest = await getRemoveRoutingIsmDomainIsmTx(
          this.base,
          currentOwner,
          {
            ismAddress: deployed.address,
            domainId: domain,
          },
        );

        transactions.push({
          annotation: `Remove ism for domain ${domain} on ${IsmType.ROUTING}`,
          networkId: this.base.getNetworkId(),
          manifest: transactionManifest,
        });
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!eqAddressRadix(config.owner, currentConfig.config.owner)) {
      const transactionManifest = await getSetRoutingIsmOwnerTx(
        this.base,
        this.gateway,
        currentOwner,
        {
          ismAddress: deployed.address,
          newOwner: config.owner,
        },
      );

      transactions.push({
        annotation: `Transfer ownership of ${IsmType.ROUTING} from ${currentConfig.config.owner} to ${config.owner}`,
        networkId: this.base.getNetworkId(),
        manifest: transactionManifest,
      });
    }

    return transactions;
  }
}
