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
import { assert, eqAddressAleo, eqOptionalAddress } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import {
  ALEO_NULL_ADDRESS,
  SUFFIX_LENGTH_LONG,
  generateSuffix,
  toAleoAddress,
} from '../utils/helper.js';
import {
  type AleoArtifactNetworkConfig,
  type AleoNetworkId,
  type AleoReceipt,
  type AnnotatedAleoTransaction,
} from '../utils/types.js';

import { getMailboxConfig } from './mailbox-query.js';
import {
  getCreateMailboxTx,
  getSetMailboxDefaultHookTx,
  getSetMailboxDefaultIsmTx,
  getSetMailboxOwnerTx,
  getSetMailboxRequiredHookTx,
} from './mailbox-tx.js';

/**
 * Reader for Aleo Mailbox.
 * Reads deployed mailbox configuration from the chain.
 */
export class AleoMailboxReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(
    protected readonly aleoNetworkId: AleoNetworkId,
    protected readonly aleoClient: AnyAleoNetworkClient,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const mailboxConfig = await getMailboxConfig(
      this.aleoClient,
      address,
      this.aleoNetworkId,
    );

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
 * Writer for Aleo Mailbox.
 * Handles deployment and updates.
 */
export class AleoMailboxWriter
  extends AleoMailboxReader
  implements ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(
    private readonly config: AleoArtifactNetworkConfig,
    aleoClient: AnyAleoNetworkClient,
    private readonly signer: AleoSigner,
  ) {
    super(config.aleoNetworkId, aleoClient);
  }

  async create(
    artifact: ArtifactNew<MailboxOnChain>,
  ): Promise<
    [ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>, AleoReceipt[]]
  > {
    const { config } = artifact;
    const allReceipts: AleoReceipt[] = [];

    // Deploy mailbox programs (mailbox, dispatch_proxy, ism_manager, hook_manager)
    const programs = await this.signer.deployProgram(
      'dispatch_proxy',
      generateSuffix(SUFFIX_LENGTH_LONG),
    );

    const mailboxProgramId = programs['mailbox'];
    assert(mailboxProgramId, 'mailbox program not deployed');
    const dispatchProxyProgramId = programs['dispatch_proxy'];
    assert(dispatchProxyProgramId, 'dispatch_proxy program not deployed');

    // 1. Create mailbox
    const createTx = getCreateMailboxTx(mailboxProgramId, this.config.domainId);
    const createReceipt = await this.signer.sendAndConfirmTransaction(createTx);
    allReceipts.push(createReceipt);

    // 2. Set dispatch proxy
    const setDispatchProxyTx = {
      programName: mailboxProgramId,
      functionName: 'set_dispatch_proxy',
      priorityFee: 0,
      privateFee: false,
      inputs: [dispatchProxyProgramId],
    };
    const dispatchProxyReceipt =
      await this.signer.sendAndConfirmTransaction(setDispatchProxyTx);
    allReceipts.push(dispatchProxyReceipt);

    const mailboxAddress = toAleoAddress(mailboxProgramId);

    // Extract addresses from artifacts
    const defaultIsmAddress = config.defaultIsm.deployed.address;
    const defaultHookAddress = config.defaultHook.deployed.address;
    const requiredHookAddress = config.requiredHook.deployed.address;

    // 3. Set default ISM (if provided and not null address)
    if (
      !eqOptionalAddress(defaultIsmAddress, ALEO_NULL_ADDRESS, eqAddressAleo)
    ) {
      const setIsmTx = getSetMailboxDefaultIsmTx(
        mailboxAddress,
        defaultIsmAddress,
      );
      const ismReceipt = await this.signer.sendAndConfirmTransaction(setIsmTx);
      allReceipts.push(ismReceipt);
    }

    // 4. Set default hook (if provided and not null address)
    if (
      !eqOptionalAddress(defaultHookAddress, ALEO_NULL_ADDRESS, eqAddressAleo)
    ) {
      const setDefaultHookTx = getSetMailboxDefaultHookTx(
        mailboxAddress,
        defaultHookAddress,
      );
      const hookReceipt =
        await this.signer.sendAndConfirmTransaction(setDefaultHookTx);
      allReceipts.push(hookReceipt);
    }

    // 5. Set required hook (if provided and not null address)
    if (
      !eqOptionalAddress(requiredHookAddress, ALEO_NULL_ADDRESS, eqAddressAleo)
    ) {
      const setRequiredHookTx = getSetMailboxRequiredHookTx(
        mailboxAddress,
        requiredHookAddress,
      );
      const requiredHookReceipt =
        await this.signer.sendAndConfirmTransaction(setRequiredHookTx);
      allReceipts.push(requiredHookReceipt);
    }

    // Note: Ownership is NOT transferred during creation to allow for
    // subsequent updates by the deployer. Use update() to transfer ownership
    // when all configuration is complete.

    const deployedArtifact: ArtifactDeployed<
      MailboxOnChain,
      DeployedMailboxAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: mailboxAddress,
        domainId: this.config.domainId,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
  ): Promise<AnnotatedAleoTransaction[]> {
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedAleoTransaction[] = [];

    // Read current state
    const currentState = await this.read(deployed.address);
    const currentConfig = currentState.config;

    // Extract addresses from artifacts
    const expectedDefaultIsmAddress = config.defaultIsm.deployed.address;
    const expectedDefaultHookAddress = config.defaultHook.deployed.address;
    const expectedRequiredHookAddress = config.requiredHook.deployed.address;

    const currentDefaultIsmAddress = currentConfig.defaultIsm.deployed.address;
    const currentDefaultHookAddress =
      currentConfig.defaultHook.deployed.address;
    const currentRequiredHookAddress =
      currentConfig.requiredHook.deployed.address;

    // 1. Update default ISM if changed
    if (
      !eqOptionalAddress(
        currentDefaultIsmAddress,
        expectedDefaultIsmAddress,
        eqAddressAleo,
      )
    ) {
      updateTxs.push({
        annotation: `Update mailbox default ISM to ${expectedDefaultIsmAddress}`,
        ...getSetMailboxDefaultIsmTx(
          deployed.address,
          expectedDefaultIsmAddress,
        ),
      });
    }

    // 2. Update default hook if changed
    if (
      !eqOptionalAddress(
        currentDefaultHookAddress,
        expectedDefaultHookAddress,
        eqAddressAleo,
      )
    ) {
      updateTxs.push({
        annotation: `Update mailbox default hook to ${expectedDefaultHookAddress}`,
        ...getSetMailboxDefaultHookTx(
          deployed.address,
          expectedDefaultHookAddress,
        ),
      });
    }

    // 3. Update required hook if changed
    if (
      !eqOptionalAddress(
        currentRequiredHookAddress,
        expectedRequiredHookAddress,
        eqAddressAleo,
      )
    ) {
      updateTxs.push({
        annotation: `Update mailbox required hook to ${expectedRequiredHookAddress}`,
        ...getSetMailboxRequiredHookTx(
          deployed.address,
          expectedRequiredHookAddress,
        ),
      });
    }

    // 4. Update owner if changed (do this last to avoid permission issues)
    if (!eqOptionalAddress(currentConfig.owner, config.owner, eqAddressAleo)) {
      updateTxs.push({
        annotation: `Transfer mailbox ownership to ${config.owner}`,
        ...getSetMailboxOwnerTx(deployed.address, config.owner),
      });
    }

    return updateTxs;
  }
}
