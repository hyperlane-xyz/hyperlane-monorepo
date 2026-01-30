import { type DeliverTxResponse } from '@cosmjs/stargate';

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
import { eqAddressCosmos, isNullish } from '@hyperlane-xyz/utils';

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
export class CosmosRoutingIsmRawReader implements ArtifactReader<
  RawRoutingIsmArtifactConfig,
  DeployedIsmAddress
> {
  constructor(protected readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await getRoutingIsmConfig(this.query, address);

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

/**
 * Writer for Cosmos Routing ISM (raw).
 * Handles deployment and updates of routing ISMs including domain route management and ownership transfers.
 */
export class CosmosRoutingIsmRawWriter
  extends CosmosRoutingIsmRawReader
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
    const receipts: DeliverTxResponse[] = [];

    const routes = Object.entries(config.domains).map(
      ([domainId, artifact]) => ({
        domainId: parseInt(domainId),
        ismAddress: artifact.deployed.address,
      }),
    );

    const transaction = await getCreateRoutingIsmTx(
      this.signer.getSignerAddress(),
      routes,
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    receipts.push(receipt);
    const ismAddress = getNewContractAddress(receipt);

    // Transfer ownership if config.owner differs from signer
    if (!eqAddressCosmos(config.owner, this.signer.getSignerAddress())) {
      const ownerTransferTx = await getSetRoutingIsmOwnerTx(
        this.signer.getSignerAddress(),
        {
          ismAddress,
          newOwner: config.owner,
        },
      );

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
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);

    const transactions: AnnotatedEncodeObject[] = [];

    // Find domains to add or update
    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? currentConfig.config.domains[domain].deployed.address
        : undefined;

      const expectedIsmAddress = expectedIsm.deployed.address;

      if (
        isNullish(currentIsmAddress) ||
        !eqAddressCosmos(currentIsmAddress, expectedIsmAddress)
      ) {
        const transaction = await getSetRoutingIsmRouteTx(
          this.signer.getSignerAddress(),
          {
            ismAddress: deployed.address,
            domainIsm: { domainId: domain, ismAddress: expectedIsmAddress },
          },
        );

        transactions.push(transaction);
      }
    }

    // Find domains to remove
    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      const desiredIsmAddress = config.domains[domain];

      if (isNullish(desiredIsmAddress)) {
        const transaction = await getRemoveRoutingIsmRouteTx(
          this.signer.getSignerAddress(),
          {
            ismAddress: deployed.address,
            domainId: domain,
          },
        );

        transactions.push(transaction);
      }
    }

    // Owner transfer must be last transaction as the current owner executes all updates
    if (!eqAddressCosmos(config.owner, currentConfig.config.owner)) {
      const transaction = await getSetRoutingIsmOwnerTx(
        this.signer.getSignerAddress(),
        {
          ismAddress: deployed.address,
          newOwner: config.owner,
        },
      );

      transactions.push(transaction);
    }

    return transactions;
  }
}
