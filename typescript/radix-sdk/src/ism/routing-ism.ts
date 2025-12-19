import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactUnderived,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  RawRoutingIsmArtifactConfig,
  ismOnChainAddress,
} from '@hyperlane-xyz/provider-sdk/ism';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressRadix, isNullish } from '@hyperlane-xyz/utils';

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

export class RadixRoutingIsmRawReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>
  > {
    const ismConfig = await getDomainRoutingIsmConfig(this.gateway, address);

    const domains: Record<number, ArtifactUnderived<DeployedIsmAddresses>> = {};
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

export class RadixRoutingIsmRawWriter
  extends RadixRoutingIsmRawReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddresses>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<RawRoutingIsmArtifactConfig>,
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
        ismAddress: ismOnChainAddress(ismAddress),
      }),
    );

    const transactionManifest = await getCreateRoutingIsmTx(
      this.base,
      this.signer.getAddress(),
      routes,
    );

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
    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? ismOnChainAddress(currentConfig.config.domains[domain])
        : undefined;

      const expectedIsmAddress = ismOnChainAddress(expectedIsm);

      if (
        isNullish(currentIsmAddress) ||
        !eqAddressRadix(currentIsmAddress, expectedIsmAddress)
      ) {
        const transactionManifest = await getSetRoutingIsmDomainIsmTx(
          this.base,
          this.signer.getAddress(),
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
          this.signer.getAddress(),
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
        this.signer.getAddress(),
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
