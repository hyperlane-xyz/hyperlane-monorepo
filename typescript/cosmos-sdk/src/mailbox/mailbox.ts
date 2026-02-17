import { type DeliverTxResponse } from '@cosmjs/stargate';

import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedMailboxAddress,
  type MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { eqAddressCosmos, eqOptionalAddress } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import {
  type CosmosMailboxQueryClient,
  getMailboxConfig,
} from './mailbox-query.js';
import {
  getCreateMailboxTx,
  getSetMailboxDefaultHookTx,
  getSetMailboxDefaultIsmTx,
  getSetMailboxOwnerTx,
  getSetMailboxRequiredHookTx,
} from './mailbox-tx.js';

/**
 * Reader for Cosmos Mailbox.
 * Reads deployed mailbox configuration from the chain.
 */
export class CosmosMailboxReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(protected readonly query: CosmosMailboxQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const mailboxConfig = await getMailboxConfig(this.query, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailboxConfig.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.defaultIsm,
          },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.defaultHook,
          },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.requiredHook,
          },
        },
      },
      deployed: {
        address: mailboxConfig.address,
        domainId: mailboxConfig.localDomain,
      },
    };
  }
}

/**
 * Writer for Cosmos Mailbox.
 * Handles deployment and updates.
 */
export class CosmosMailboxWriter
  extends CosmosMailboxReader
  implements ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(
    query: CosmosMailboxQueryClient,
    private readonly signer: CosmosNativeSigner,
    private readonly domainId: number,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MailboxOnChain>,
  ): Promise<
    [
      ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
      DeliverTxResponse[],
    ]
  > {
    const { config } = artifact;
    const allReceipts: DeliverTxResponse[] = [];
    const signerAddress = this.signer.getSignerAddress();

    // Extract addresses from artifacts (can be UNDERIVED or DEPLOYED)
    const defaultIsmAddress = config.defaultIsm.deployed.address;
    const defaultHookAddress = config.defaultHook.deployed.address;
    const requiredHookAddress = config.requiredHook.deployed.address;

    // 1. Create mailbox with signer as initial owner
    const createTx = getCreateMailboxTx(signerAddress, {
      domainId: this.domainId,
      defaultIsmAddress,
    });
    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    const mailboxAddress = getNewContractAddress(createReceipt);
    allReceipts.push(createReceipt);

    // 2. Set default hook if provided
    if (!eqOptionalAddress(defaultHookAddress, undefined, eqAddressCosmos)) {
      const setDefaultHookTx = getSetMailboxDefaultHookTx(signerAddress, {
        mailboxAddress,
        hookAddress: defaultHookAddress,
      });

      const hookReceipt =
        await this.signer.sendAndConfirmTransaction(setDefaultHookTx);
      allReceipts.push(hookReceipt);
    }

    // 3. Set required hook if provided
    if (!eqOptionalAddress(requiredHookAddress, undefined, eqAddressCosmos)) {
      const setRequiredHookTx = getSetMailboxRequiredHookTx(signerAddress, {
        mailboxAddress,
        hookAddress: requiredHookAddress,
      });

      const hookReceipt =
        await this.signer.sendAndConfirmTransaction(setRequiredHookTx);
      allReceipts.push(hookReceipt);
    }

    // Note: Ownership is NOT transferred during creation. The deployer retains
    // ownership to allow setting ISM and hooks after initial deployment, which
    // require owner permissions. Use update() to transfer ownership to the
    // intended owner once all configuration is complete.

    const deployedArtifact: ArtifactDeployed<
      MailboxOnChain,
      DeployedMailboxAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config,
      deployed: {
        address: mailboxAddress,
        domainId: this.domainId,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
  ): Promise<AnnotatedEncodeObject[]> {
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedEncodeObject[] = [];

    // Read current state
    const currentState = await this.read(deployed.address);
    const currentConfig = currentState.config;
    const currentOwner = currentConfig.owner;

    const expectedDefaultIsmAddress = config.defaultIsm.deployed.address;
    const expectedDefaultHookAddress = config.defaultHook.deployed.address;
    const expectedRequiredHookAddress = config.requiredHook.deployed.address;

    const currentDefaultIsmAddress = currentConfig.defaultIsm.deployed.address;
    const currentDefaultHookAddress =
      currentConfig.defaultHook.deployed.address;
    const currentRequiredHookAddress =
      currentConfig.requiredHook.deployed.address;

    // Compare and generate update transactions
    // 1. Update default ISM
    if (
      !eqOptionalAddress(
        currentDefaultIsmAddress,
        expectedDefaultIsmAddress,
        eqAddressCosmos,
      )
    ) {
      const setIsmTx = getSetMailboxDefaultIsmTx(currentOwner, {
        mailboxAddress: deployed.address,
        ismAddress: expectedDefaultIsmAddress,
      });
      updateTxs.push(setIsmTx);
    }

    // 2. Update default hook
    if (
      !eqOptionalAddress(
        currentDefaultHookAddress,
        expectedDefaultHookAddress,
        eqAddressCosmos,
      )
    ) {
      const setDefaultHookTx = getSetMailboxDefaultHookTx(currentOwner, {
        mailboxAddress: deployed.address,
        hookAddress: expectedDefaultHookAddress,
      });
      updateTxs.push(setDefaultHookTx);
    }

    // 3. Update required hook
    if (
      !eqOptionalAddress(
        currentRequiredHookAddress,
        expectedRequiredHookAddress,
        eqAddressCosmos,
      )
    ) {
      const setRequiredHookTx = getSetMailboxRequiredHookTx(currentOwner, {
        mailboxAddress: deployed.address,
        hookAddress: expectedRequiredHookAddress,
      });
      updateTxs.push(setRequiredHookTx);
    }

    // 4. Update owner (LAST to avoid permission issues)
    if (!eqOptionalAddress(currentOwner, config.owner, eqAddressCosmos)) {
      const setOwnerTx = getSetMailboxOwnerTx(currentOwner, {
        mailboxAddress: deployed.address,
        newOwner: config.owner,
      });
      updateTxs.push(setOwnerTx);
    }

    return updateTxs;
  }
}
