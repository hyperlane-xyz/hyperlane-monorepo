import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactUnderived,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { eqAddress, isNullish } from '@hyperlane-xyz/utils';

import { AltVM } from '../../index.js';
import { AnnotatedTx, TxReceipt } from '../../module.js';

export class RoutingIsmRawReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(protected readonly provider: AltVM.IProvider) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await this.provider.getRoutingIsm({
      ismAddress: address,
    });

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

export class RoutingIsmRawWriter
  extends RoutingIsmRawReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(
    provider: AltVM.IProvider,
    private readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<RawRoutingIsmArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const receipts: TxReceipt[] = [];

    const { ismAddress, receipts: createReceipts } =
      await this.signer.createRoutingIsm({
        routes: [],
      });
    receipts.push(...createReceipts);

    for (const [domainId, domainIsm] of Object.entries(config.domains)) {
      const { receipts: setRouteReceipts } =
        await this.signer.setRoutingIsmRoute({
          ismAddress,
          route: {
            domainId: parseInt(domainId),
            ismAddress: domainIsm.deployed.address,
          },
        });
      receipts.push(...setRouteReceipts);
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
  ): Promise<AnnotatedTx[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);
    const transactions: AnnotatedTx[] = [];

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
        const txs = await this.provider.getSetRoutingIsmRouteTransaction({
          signer: this.signer.getSignerAddress(),
          ismAddress: deployed.address,
          route: {
            domainId: domain,
            ismAddress: expectedIsmAddress,
          },
        });

        transactions.push(...txs);
      }
    }

    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      const desiredIsmAddress = config.domains[domain];

      if (isNullish(desiredIsmAddress)) {
        const txs = await this.provider.getRemoveRoutingIsmRouteTransaction({
          signer: this.signer.getSignerAddress(),
          ismAddress: deployed.address,
          domainId: domain,
        });

        transactions.push(...txs);
      }
    }

    if (!eqAddress(config.owner, currentConfig.config.owner)) {
      const txs = await this.provider.getSetRoutingIsmOwnerTransaction({
        signer: this.signer.getSignerAddress(),
        ismAddress: deployed.address,
        newOwner: config.owner,
      });

      transactions.push(...txs);
    }

    return transactions;
  }
}
