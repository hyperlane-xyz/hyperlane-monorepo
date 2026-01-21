import { eqAddress, isNullish } from '@hyperlane-xyz/utils';

import { IsmType } from '../altvm.js';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactUnderived,
  ArtifactWriter,
} from '../artifact.js';
import { IsmQuery, IsmSigner } from '../interfaces/IsmInterface.js';
import { DeployedIsmAddress, RawRoutingIsmArtifactConfig } from '../ism.js';

export class RoutingIsmRawReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(protected readonly query: IsmQuery) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await this.query.getRoutingIsm({
      ismAddress: address,
    });

    // Convert routes to UNDERIVED artifacts (address-only references)
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

export class RoutingIsmRawWriter<T, R>
  extends RoutingIsmRawReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(private readonly signer: IsmSigner<T, R>) {
    super(signer);
  }

  async create(
    artifact: ArtifactNew<RawRoutingIsmArtifactConfig>,
  ): Promise<
    [ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>, any[]]
  > {
    const { config } = artifact;
    const createReceipts: any[] = [];

    const routes = Object.entries(config.domains).map(
      ([domainId, artifact]) => ({
        domainId: parseInt(domainId),
        ismAddress: artifact.deployed.address,
      }),
    );

    const txs = await this.signer.getCreateRoutingIsmTxs({
      signer: this.signer.getSignerAddress(),
      routes,
    });

    const receipts = await this.signer.sendAndConfirmTxs(txs);
    createReceipts.push(...receipts);
    const ismAddress = await this.signer.getAddressFromReceipts(receipts);

    // Transfer ownership if config.owner differs from signer
    if (!eqAddress(config.owner, this.signer.getSignerAddress())) {
      const ownerTransferTxs = await this.signer.getSetRoutingIsmOwnerTxs({
        signer: this.signer.getSignerAddress(),
        ismAddress,
        newOwner: config.owner,
      });

      const ownerReceipts =
        await this.signer.sendAndConfirmTxs(ownerTransferTxs);
      receipts.push(...ownerReceipts);
    }

    const deployedArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<any[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);

    const transactions: any[] = [];

    // Find domains to add or update
    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? currentConfig.config.domains[domain].deployed.address
        : undefined;

      const expectedIsmAddress = expectedIsm.deployed.address;

      if (
        isNullish(currentIsmAddress) ||
        !eqAddress(currentIsmAddress, expectedIsmAddress)
      ) {
        const txs = await this.signer.getSetRoutingIsmRouteTxs({
          signer: this.signer.getSignerAddress(),
          ismAddress: deployed.address,
          route: { domainId: domain, ismAddress: expectedIsmAddress },
        });

        transactions.push(...txs);
      }
    }

    // Find domains to remove
    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      const desiredIsmAddress = config.domains[domain];

      if (isNullish(desiredIsmAddress)) {
        const txs = await this.signer.getRemoveRoutingIsmRouteTxs({
          signer: this.signer.getSignerAddress(),
          ismAddress: deployed.address,
          domainId: domain,
        });

        transactions.push(txs);
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!eqAddress(config.owner, currentConfig.config.owner)) {
      const txs = await this.signer.getSetRoutingIsmOwnerTxs({
        signer: this.signer.getSignerAddress(),
        ismAddress: deployed.address,
        newOwner: config.owner,
      });

      transactions.push(...txs);
    }

    return transactions;
  }
}
