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
import { eqAddressAleo } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { getNewContractExpectedNonce } from '../utils/base-query.js';
import {
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getNewIsmAddress } from './base.js';
import { getRoutingIsmConfig } from './ism-query.js';
import {
  getCreateRoutingIsmTx,
  getRemoveRoutingIsmRouteTx,
  getSetRoutingIsmOwnerTx,
  getSetRoutingIsmRouteTx,
} from './ism-tx.js';

export class AleoRoutingIsmReader
  implements ArtifactReader<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
  > {
    const ismConfig = await getRoutingIsmConfig(this.aleoClient, address);
    return routingIsmQueryResultToArtifact(ismConfig);
  }
}

export class AleoRoutingIsmWriter
  extends AleoRoutingIsmReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<RawRoutingIsmArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<RawRoutingIsmArtifactConfig, DeployedIsmAddress>,
      AleoReceipt[],
    ]
  > {
    const { config } = artifact;
    const ismManagerProgramId = await this.signer.getIsmManager();
    const receipts: AleoReceipt[] = [];

    const createTransaction = getCreateRoutingIsmTx(ismManagerProgramId);

    const expectedNonce = await getNewContractExpectedNonce(
      this.aleoClient,
      ismManagerProgramId,
    );

    const createReceipt =
      await this.signer.sendAndConfirmTransaction(createTransaction);
    receipts.push(createReceipt);

    const ismAddress = await getNewIsmAddress(
      this.aleoClient,
      ismManagerProgramId,
      expectedNonce,
    );

    for (const [domainId, domainIsm] of Object.entries(config.domains)) {
      const setRouteTransaction = getSetRoutingIsmRouteTx(ismAddress, {
        domainId: parseInt(domainId),
        ismAddress: domainIsm.deployed.address,
      });

      const setRouteReceipt =
        await this.signer.sendAndConfirmTransaction(setRouteTransaction);
      receipts.push(setRouteReceipt);
    }

    if (!eqAddressAleo(config.owner, this.signer.getSignerAddress())) {
      const ownerTransferTx = getSetRoutingIsmOwnerTx(ismAddress, config.owner);

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
  ): Promise<AnnotatedAleoTransaction[]> {
    const currentConfig = await this.read(artifact.deployed.address);

    // Pure data: compute domain route changes
    const changes = computeRoutingIsmDomainChanges(
      currentConfig,
      artifact.config,
      eqAddressAleo,
    );

    // Convert changes to transactions
    const transactions: AnnotatedAleoTransaction[] = [];

    for (const { domain, ismAddress } of changes.setRoutes) {
      const tx = getSetRoutingIsmRouteTx(artifact.deployed.address, {
        domainId: domain,
        ismAddress,
      });
      transactions.push({
        annotation: `Set ISM for domain ${domain} to ISM ${ismAddress}`,
        ...tx,
      });
    }

    for (const { domain } of changes.removeRoutes) {
      const tx = getRemoveRoutingIsmRouteTx(artifact.deployed.address, domain);
      transactions.push({
        annotation: `Remove ISM for domain ${domain}`,
        ...tx,
      });
    }

    // Ownership transfer (must be last as current owner executes all updates)
    if (!eqAddressAleo(artifact.config.owner, currentConfig.config.owner)) {
      const tx = getSetRoutingIsmOwnerTx(
        artifact.deployed.address,
        artifact.config.owner,
      );
      transactions.push({
        annotation: `Transfer ownership from ${currentConfig.config.owner} to ${artifact.config.owner}`,
        ...tx,
      });
    }

    return transactions;
  }
}
