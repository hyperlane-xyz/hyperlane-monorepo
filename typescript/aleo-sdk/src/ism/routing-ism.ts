import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  BaseRoutingIsmRawReader,
  BaseRoutingIsmRawWriter,
  type DeployedIsmAddress,
  type RawRoutingIsmArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
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

export class AleoRoutingIsmRawReader extends BaseRoutingIsmRawReader<AnyAleoNetworkClient> {
  constructor(aleoClient: AnyAleoNetworkClient) {
    super(aleoClient, (client, address) =>
      getRoutingIsmConfig(client, address),
    );
  }
}

export class AleoRoutingIsmRawWriter extends BaseRoutingIsmRawWriter<
  AnyAleoNetworkClient,
  AnnotatedAleoTransaction,
  AleoReceipt
> {
  constructor(
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(
      aleoClient,
      (client, address) => getRoutingIsmConfig(client, address),
      eqAddressAleo,
      {
        // Note: Aleo's create flow is special (empty ISM + set routes), handled in overridden create()
        create: async () => {
          throw new Error('Use overridden create() method');
        },
        setRoute: async (_signerAddress, config) =>
          getSetRoutingIsmRouteTx(config.ismAddress, config.domainIsm),
        removeRoute: async (_signerAddress, config) =>
          getRemoveRoutingIsmRouteTx(config.ismAddress, config.domainId),
        setOwner: async (_signerAddress, config) =>
          getSetRoutingIsmOwnerTx(config.ismAddress, config.newOwner),
      },
      async () => {
        throw new Error('Use overridden create() method');
      },
      () => '', // Aleo doesn't need signer address for tx building
      async (tx) => signer.sendAndConfirmTransaction(tx),
    );
  }

  /**
   * Override create() to handle Aleo's special flow: create empty ISM, then set routes
   */
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

    // Create empty routing ISM
    const createTransaction = getCreateRoutingIsmTx(ismManagerProgramId);
    const expectedNonce = await getNewContractExpectedNonce(
      this.client as AnyAleoNetworkClient,
      ismManagerProgramId,
    );
    const createReceipt =
      await this.signer.sendAndConfirmTransaction(createTransaction);
    receipts.push(createReceipt);

    const ismAddress = await getNewIsmAddress(
      this.client as AnyAleoNetworkClient,
      ismManagerProgramId,
      expectedNonce,
    );

    // Set routes for each domain
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

    const deployedArtifact = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    } as const;

    return [deployedArtifact, receipts];
  }
}
