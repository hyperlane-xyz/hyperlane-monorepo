import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
  type DeployedIsmAddress,
  type RawRoutingIsmArtifactConfig,
  computeRoutingIsmDomainChanges,
  routingIsmQueryResultToArtifact,
} from '@hyperlane-xyz/provider-sdk';
import { type TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { type AnnotatedRadixTransaction } from '../utils/types.js';

import { getDomainRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmDomainIsmTx,
  getSetRoutingIsmDomainIsmTx,
  getSetRoutingIsmOwnerTx,
} from './ism-tx.js';

export class RadixRoutingIsmReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await getDomainRoutingIsmConfig(this.gateway, address);
    return routingIsmQueryResultToArtifact(ismConfig);
  }
}

export class RadixRoutingIsmWriter
  extends RadixRoutingIsmReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
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
      ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
      TxReceipt[],
    ]
  > {
    const { config } = artifact;
    const receipts: TxReceipt[] = [];

    const routes = Object.entries(config.domains).map(
      ([domainId, ismAddress]) => ({
        domainId: parseInt(domainId),
        ismAddress: ismAddress.deployed.address,
      }),
    );

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
      RawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, receipts];
  }

  async update(
    artifact: ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedRadixTransaction[]> {
    const currentConfig = await this.read(artifact.deployed.address);
    const signerAddress = this.signer.getAddress();

    // Pure data: compute domain route changes
    const changes = computeRoutingIsmDomainChanges(
      currentConfig,
      artifact.config,
      eqAddressRadix,
    );

    // Convert changes to transactions
    const transactions: AnnotatedRadixTransaction[] = [];

    for (const { domain, ismAddress } of changes.setRoutes) {
      const manifest = await getSetRoutingIsmDomainIsmTx(
        this.base,
        signerAddress,
        {
          ismAddress: artifact.deployed.address,
          domainIsm: { domainId: domain, ismAddress },
        },
      );
      transactions.push({
        annotation: `Set ISM for domain ${domain} to ISM ${ismAddress}`,
        networkId: this.base.getNetworkId(),
        manifest,
      });
    }

    for (const { domain } of changes.removeRoutes) {
      const manifest = await getRemoveRoutingIsmDomainIsmTx(
        this.base,
        signerAddress,
        {
          ismAddress: artifact.deployed.address,
          domainId: domain,
        },
      );
      transactions.push({
        annotation: `Remove ISM for domain ${domain}`,
        networkId: this.base.getNetworkId(),
        manifest,
      });
    }

    // Ownership transfer (must be last as current owner executes all updates)
    if (!eqAddressRadix(artifact.config.owner, currentConfig.config.owner)) {
      const manifest = await getSetRoutingIsmOwnerTx(
        this.base,
        this.gateway,
        signerAddress,
        {
          ismAddress: artifact.deployed.address,
          newOwner: artifact.config.owner,
        },
      );
      transactions.push({
        annotation: `Transfer ownership from ${currentConfig.config.owner} to ${artifact.config.owner}`,
        networkId: this.base.getNetworkId(),
        manifest,
      });
    }

    return transactions;
  }
}
