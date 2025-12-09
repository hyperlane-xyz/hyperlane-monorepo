import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressRadix, isNullish } from '@hyperlane-xyz/utils';

import { RadixCorePopulate } from '../core/populate.js';
import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getDomainRoutingIsmConfig } from './ism-query.js';

export class RadixRoutingIsmRawReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(private readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>
  > {
    const ismConfig = await getDomainRoutingIsmConfig(this.gateway, address);

    const domains: Record<number, string> = {};
    for (const route of ismConfig.routes) {
      domains[route.domainId] = route.ismAddress;
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

export class RadixRoutingIsmRawWriter
  extends RadixRoutingIsmRawReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly populate: RadixCorePopulate,
    private readonly base: RadixBase,
    private readonly accountAddress: string,
  ) {
    super(gateway);
  }

  async create(
    artifact: Artifact<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>,
  ): Promise<
    [
      ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;

    const routes = Object.entries(config.domains).map(
      ([domainId, ismAddress]) => ({
        domainId: parseInt(domainId),
        ismAddress,
      }),
    );

    const transactionManifest = await this.populate.createRoutingIsm({
      from_address: this.accountAddress,
      routes,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);
    const address = await this.base.getNewComponent(receipt);

    const deployedArtifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddresses
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    artifact: ArtifactDeployed<
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddresses
    >,
  ): Promise<AnnotatedRadixTransaction[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);

    const transactions: AnnotatedRadixTransaction[] = [];

    // Find domains to add
    for (const [domainId, ismAddress] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain];

      if (
        isNullish(currentIsmAddress) ||
        !eqAddressRadix(currentIsmAddress, ismAddress)
      ) {
        const transactionManifest = await this.populate.setRoutingIsmRoute({
          from_address: this.accountAddress,
          ism: deployed.address,
          route: { domainId: domain, ismAddress },
        });

        transactions.push({
          annotation: `Set route for domain ${domain} to ISM ${ismAddress}`,
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
        const transactionManifest = await this.populate.removeRoutingIsmRoute({
          from_address: this.accountAddress,
          ism: deployed.address,
          domain,
        });

        transactions.push({
          annotation: `Remove route for domain ${domain}`,
          networkId: this.base.getNetworkId(),
          manifest: transactionManifest,
        });
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!eqAddressRadix(config.owner, currentConfig.config.owner)) {
      const transactionManifest = await this.populate.setRoutingIsmOwner({
        from_address: this.accountAddress,
        ism: deployed.address,
        new_owner: config.owner,
      });

      transactions.push({
        annotation: `Transfer ownership to ${config.owner}`,
        networkId: this.base.getNetworkId(),
        manifest: transactionManifest,
      });
    }

    return transactions;
  }
}
