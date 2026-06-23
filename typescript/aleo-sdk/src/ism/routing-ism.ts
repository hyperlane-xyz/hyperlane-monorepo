import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactComposition,
  ArtifactState,
  type ArtifactUnderived,
  type WithCompositionVariant,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { eqAddressAleo, isNullish } from '@hyperlane-xyz/utils';

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

type OrchestratedRawRoutingIsmArtifactConfig = WithCompositionVariant<
  RawRoutingIsmArtifactConfig,
  typeof ArtifactComposition.ORCHESTRATED
>;

export class AleoRoutingIsmRawReader implements ArtifactReader<
  RawRoutingIsmArtifactConfig,
  DeployedIsmAddress
> {
  readonly composition = ArtifactComposition.ORCHESTRATED;

  constructor(protected readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      OrchestratedRawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >
  > {
    const ismConfig = await getRoutingIsmConfig(this.aleoClient, address);

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

export class AleoRoutingIsmRawWriter
  extends AleoRoutingIsmRawReader
  implements ArtifactWriter<RawRoutingIsmArtifactConfig, DeployedIsmAddress>
{
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(aleoClient);
  }

  async create(
    artifact: ArtifactNew<OrchestratedRawRoutingIsmArtifactConfig>,
  ): Promise<
    [
      ArtifactDeployed<
        OrchestratedRawRoutingIsmArtifactConfig,
        DeployedIsmAddress
      >,
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
      OrchestratedRawRoutingIsmArtifactConfig,
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
    artifact: ArtifactDeployed<
      OrchestratedRawRoutingIsmArtifactConfig,
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedAleoTransaction[]> {
    const { config, deployed } = artifact;
    const currentConfig = await this.read(deployed.address);
    const transactions: AnnotatedAleoTransaction[] = [];

    for (const [domainId, expectedIsm] of Object.entries(config.domains)) {
      const domain = parseInt(domainId);
      const currentIsmAddress = currentConfig.config.domains[domain]
        ? currentConfig.config.domains[domain].deployed.address
        : undefined;

      const expectedIsmAddress = expectedIsm.deployed.address;

      if (
        isNullish(currentIsmAddress) ||
        !eqAddressAleo(currentIsmAddress, expectedIsmAddress)
      ) {
        const transaction = getSetRoutingIsmRouteTx(deployed.address, {
          domainId: domain,
          ismAddress: expectedIsmAddress,
        });

        transactions.push(transaction);
      }
    }

    for (const domainId of Object.keys(currentConfig.config.domains)) {
      const domain = parseInt(domainId);
      const desiredIsmAddress = config.domains[domain];

      if (isNullish(desiredIsmAddress)) {
        const transaction = getRemoveRoutingIsmRouteTx(
          deployed.address,
          domain,
        );

        transactions.push(transaction);
      }
    }

    if (!eqAddressAleo(config.owner, currentConfig.config.owner)) {
      const transaction = getSetRoutingIsmOwnerTx(
        deployed.address,
        config.owner,
      );

      transactions.push(transaction);
    }

    return transactions;
  }
}
