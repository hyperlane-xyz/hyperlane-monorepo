import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedMailboxAddress,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import {
  ZERO_ADDRESS_HEX_32,
  eqAddressRadix,
  eqOptionalAddress,
} from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { getMailboxConfig } from './mailbox-query.js';
import {
  getCreateMailboxTx,
  getSetMailboxDefaultHookTx,
  getSetMailboxDefaultIsmTx,
  getSetMailboxOwnerTx,
  getSetMailboxRequiredHookTx,
} from './mailbox-tx.js';

export class RadixMailboxReader
  implements ArtifactReader<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(protected readonly gateway: Readonly<GatewayApiClient>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>> {
    const mailboxConfig = await getMailboxConfig(this.gateway, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        owner: mailboxConfig.owner,
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.defaultIsm || ZERO_ADDRESS_HEX_32,
          },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.defaultHook || ZERO_ADDRESS_HEX_32,
          },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: {
            address: mailboxConfig.requiredHook || ZERO_ADDRESS_HEX_32,
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

export class RadixMailboxWriter
  extends RadixMailboxReader
  implements ArtifactWriter<MailboxOnChain, DeployedMailboxAddress>
{
  constructor(
    gateway: Readonly<GatewayApiClient>,
    private readonly signer: RadixBaseSigner,
    private readonly base: RadixBase,
    private readonly domainId: number,
  ) {
    super(gateway);
  }

  async create(
    artifact: ArtifactNew<MailboxOnChain>,
  ): Promise<
    [ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>, TxReceipt[]]
  > {
    const { config } = artifact;
    const allReceipts: TxReceipt[] = [];

    // Extract addresses from artifact references
    const defaultIsmAddress = config.defaultIsm.deployed.address;
    const defaultHookAddress = config.defaultHook.deployed.address;
    const requiredHookAddress = config.requiredHook.deployed.address;

    // Create the mailbox (mailbox is created with signer as initial owner)
    const createTx = await getCreateMailboxTx(
      this.base,
      this.signer.getAddress(),
      this.domainId,
    );

    const createReceipt = await this.signer.signAndBroadcast(createTx);
    const address = await this.base.getNewComponent(createReceipt);
    allReceipts.push(createReceipt);

    // Set default ISM (only if not zero address)
    if (defaultIsmAddress !== ZERO_ADDRESS_HEX_32) {
      const setIsmTx = await getSetMailboxDefaultIsmTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: address,
          ismAddress: defaultIsmAddress,
        },
      );
      const ismReceipt = await this.signer.signAndBroadcast(setIsmTx);
      allReceipts.push(ismReceipt);
    }

    // Set default hook (only if not zero address)
    if (
      !eqOptionalAddress(
        defaultHookAddress,
        ZERO_ADDRESS_HEX_32,
        eqAddressRadix,
      )
    ) {
      const setDefaultHookTx = await getSetMailboxDefaultHookTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: address,
          hookAddress: defaultHookAddress,
        },
      );
      const defaultHookReceipt =
        await this.signer.signAndBroadcast(setDefaultHookTx);
      allReceipts.push(defaultHookReceipt);
    }

    // Set required hook (only if not zero address)
    if (
      !eqOptionalAddress(
        requiredHookAddress,
        ZERO_ADDRESS_HEX_32,
        eqAddressRadix,
      )
    ) {
      const setRequiredHookTx = await getSetMailboxRequiredHookTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: address,
          hookAddress: requiredHookAddress,
        },
      );
      const requiredHookReceipt =
        await this.signer.signAndBroadcast(setRequiredHookTx);
      allReceipts.push(requiredHookReceipt);
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
      config: artifact.config,
      deployed: {
        address,
        domainId: this.domainId,
      },
    };

    return [deployedArtifact, allReceipts];
  }

  async update(
    artifact: ArtifactDeployed<MailboxOnChain, DeployedMailboxAddress>,
  ): Promise<AnnotatedRadixTransaction[]> {
    const { config, deployed } = artifact;
    const updateTxs: AnnotatedRadixTransaction[] = [];

    // Read current state
    const currentState = await this.read(deployed.address);

    // Extract addresses from artifact references
    const expectedDefaultIsmAddress = config.defaultIsm.deployed.address;
    const expectedDefaultHookAddress = config.defaultHook.deployed.address;
    const expectedRequiredHookAddress = config.requiredHook.deployed.address;

    // Extract addresses from current state
    const currentDefaultIsmAddress =
      currentState.config.defaultIsm.deployed.address;
    const currentDefaultHookAddress =
      currentState.config.defaultHook.deployed.address;
    const currentRequiredHookAddress =
      currentState.config.requiredHook.deployed.address;

    // Update default ISM if changed
    if (
      !eqOptionalAddress(
        currentDefaultIsmAddress,
        expectedDefaultIsmAddress,
        eqAddressRadix,
      )
    ) {
      const setIsmTx = await getSetMailboxDefaultIsmTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          ismAddress: expectedDefaultIsmAddress,
        },
      );
      updateTxs.push({
        annotation: `Update mailbox default ISM to ${expectedDefaultIsmAddress}`,
        networkId: this.base.getNetworkId(),
        manifest: setIsmTx,
      });
    }

    // Update default hook if changed
    if (
      !eqOptionalAddress(
        currentDefaultHookAddress,
        expectedDefaultHookAddress,
        eqAddressRadix,
      )
    ) {
      const setDefaultHookTx = await getSetMailboxDefaultHookTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          hookAddress: expectedDefaultHookAddress,
        },
      );
      updateTxs.push({
        annotation: `Update mailbox default hook to ${expectedDefaultHookAddress}`,
        networkId: this.base.getNetworkId(),
        manifest: setDefaultHookTx,
      });
    }

    // Update required hook if changed
    if (
      !eqOptionalAddress(
        currentRequiredHookAddress,
        expectedRequiredHookAddress,
        eqAddressRadix,
      )
    ) {
      const setRequiredHookTx = await getSetMailboxRequiredHookTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          hookAddress: expectedRequiredHookAddress,
        },
      );
      updateTxs.push({
        annotation: `Update mailbox required hook to ${expectedRequiredHookAddress}`,
        networkId: this.base.getNetworkId(),
        manifest: setRequiredHookTx,
      });
    }

    // Update owner if changed (do this last to avoid permission issues)
    if (!eqAddressRadix(currentState.config.owner, config.owner)) {
      const setOwnerTx = await getSetMailboxOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          newOwner: config.owner,
        },
      );
      updateTxs.push({
        annotation: `Transfer mailbox ownership to ${config.owner}`,
        networkId: this.base.getNetworkId(),
        manifest: setOwnerTx,
      });
    }

    return updateTxs;
  }
}
