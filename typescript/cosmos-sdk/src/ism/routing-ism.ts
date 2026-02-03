import { type DeliverTxResponse } from '@cosmjs/stargate';

import {
  type ArtifactDeployed,
  type DeployedIsmAddress,
  type RawRoutingIsmArtifactConfig,
  computeRoutingIsmDomainChanges,
} from '@hyperlane-xyz/provider-sdk';
import {
  AltvmRoutingIsmReader,
  AltvmRoutingIsmWriter,
} from '@hyperlane-xyz/provider-sdk/ism';
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
export class CosmosRoutingIsmReader extends AltvmRoutingIsmReader<CosmosIsmQueryClient> {
  constructor(query: CosmosIsmQueryClient) {
    super(query, (client, address) => getRoutingIsmConfig(client, address));
  }
}

/**
 * Writer for Cosmos Routing ISM (raw).
 * Handles deployment and updates of routing ISMs including domain route management and ownership transfers.
 */
export class CosmosRoutingIsmWriter extends AltvmRoutingIsmWriter<
  CosmosIsmQueryClient,
  AnnotatedEncodeObject,
  DeliverTxResponse
> {
  constructor(query: CosmosIsmQueryClient, signer: CosmosNativeSigner) {
    super(
      query,
      (client, address) => getRoutingIsmConfig(client, address),
      eqAddressCosmos,
      {
        create: getCreateRoutingIsmTx,
        setRoute: getSetRoutingIsmRouteTx,
        removeRoute: getRemoveRoutingIsmRouteTx,
        setOwner: getSetRoutingIsmOwnerTx,
      },
      async (receipt) => getNewContractAddress(receipt),
      () => signer.getSignerAddress(),
      async (tx) => signer.sendAndConfirmTransaction(tx),
    );
  }

  async update(
    artifact: ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
  ): Promise<Array<AnnotatedEncodeObject & { annotation?: string }>> {
    const currentConfig = await this.read(artifact.deployed.address);
    const signerAddress = await this.getSignerAddress();

    // Pure data: compute domain route changes
    const changes = computeRoutingIsmDomainChanges(
      currentConfig,
      artifact.config,
      eqAddressCosmos,
    );

    // Convert changes to transactions
    const transactions: Array<AnnotatedEncodeObject & { annotation?: string }> =
      [];

    for (const { domain, ismAddress } of changes.setRoutes) {
      const tx = await getSetRoutingIsmRouteTx(signerAddress, {
        ismAddress: artifact.deployed.address,
        domainIsm: { domainId: domain, ismAddress },
      });
      transactions.push({
        annotation: `Set ISM for domain ${domain} to ISM ${ismAddress}`,
        ...tx,
      });
    }

    for (const { domain } of changes.removeRoutes) {
      const tx = await getRemoveRoutingIsmRouteTx(signerAddress, {
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
      const tx = await getSetRoutingIsmOwnerTx(signerAddress, {
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
