import { type DeliverTxResponse } from '@cosmjs/stargate';

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
import { eqAddressCosmos } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import { type CosmosIsmQueryClient, getRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmRouteTx,
  getSetRoutingIsmOwnerTx,
  getSetRoutingIsmRouteTx,
} from './ism-tx.js';

/**
 * Reader for Cosmos Routing ISM (raw, with underived nested ISMs).
 * Returns nested ISMs as address-only references (UNDERIVED state).
 * The GenericIsmReader from deploy-sdk handles recursive expansion of nested ISMs.
 */
export class CosmosRoutingIsmReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(protected readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await getRoutingIsmConfig(this.query, address);
    return routingIsmQueryResultToArtifact(ismConfig);
  }
}

/**
 * Writer for Cosmos Routing ISM (raw).
 * Handles deployment and updates of routing ISMs including domain route management and ownership transfers.
 */
export class CosmosRoutingIsmWriter
  extends CosmosRoutingIsmReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(
    query: CosmosIsmQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<RawRoutingIsmArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
      DeliverTxResponse[],
    ]
  > {
    const { config } = artifact;
    const signerAddress = this.signer.getSignerAddress();
    const receipts: DeliverTxResponse[] = [];

    const routes = Object.entries(config.domains).map(
      ([domainId, artifact]) => ({
        domainId: parseInt(domainId),
        ismAddress: artifact.deployed.address,
      }),
    );

    const transaction = getCreateRoutingIsmTx(signerAddress, routes);

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    receipts.push(receipt);
    const ismAddress = getNewContractAddress(receipt);

    // Transfer ownership if config.owner differs from signer
    if (!eqAddressCosmos(config.owner, signerAddress)) {
      const ownerTransferTx = getSetRoutingIsmOwnerTx(signerAddress, {
        ismAddress,
        newOwner: config.owner,
      });

      const ownerReceipt =
        await this.signer.sendAndConfirmTransaction(ownerTransferTx);
      receipts.push(ownerReceipt);
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
  ): Promise<AnnotatedEncodeObject[]> {
    const currentConfig = await this.read(artifact.deployed.address);
    const signerAddress = this.signer.getSignerAddress();

    // Pure data: compute domain route changes
    const changes = computeRoutingIsmDomainChanges(
      currentConfig,
      artifact.config,
      eqAddressCosmos,
    );

    // Convert changes to transactions
    const transactions: AnnotatedEncodeObject[] = [];

    for (const { domain, ismAddress } of changes.setRoutes) {
      const tx = getSetRoutingIsmRouteTx(signerAddress, {
        ismAddress: artifact.deployed.address,
        domainIsm: { domainId: domain, ismAddress },
      });
      transactions.push({
        annotation: `Set ISM for domain ${domain} to ISM ${ismAddress}`,
        ...tx,
      });
    }

    for (const { domain } of changes.removeRoutes) {
      const tx = getRemoveRoutingIsmRouteTx(signerAddress, {
        ismAddress: artifact.deployed.address,
        domainId: domain,
      });
      transactions.push({
        annotation: `Remove ISM for domain ${domain}`,
        ...tx,
      });
    }

    // Ownership transfer (must be last as current owner executes all updates)
    if (!eqAddressCosmos(artifact.config.owner, currentConfig.config.owner)) {
      const tx = getSetRoutingIsmOwnerTx(signerAddress, {
        ismAddress: artifact.deployed.address,
        newOwner: artifact.config.owner,
      });
      transactions.push({
        annotation: `Transfer ownership from ${currentConfig.config.owner} to ${artifact.config.owner}`,
        ...tx,
      });
    }

    return transactions;
  }
}
