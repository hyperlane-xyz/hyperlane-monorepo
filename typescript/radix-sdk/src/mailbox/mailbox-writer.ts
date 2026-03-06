import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedMailboxAddress,
  MailboxOnChain,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { TxReceipt } from '@hyperlane-xyz/provider-sdk/module';
import { ZERO_ADDRESS_HEX_32, eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { AnnotatedRadixTransaction } from '../utils/types.js';

import { RadixMailboxReader } from './mailbox-reader.js';
import {
  getCreateMailboxTx,
  getSetMailboxDefaultHookTx,
  getSetMailboxDefaultIsmTx,
  getSetMailboxOwnerTx,
  getSetMailboxRequiredHookTx,
} from './mailbox-tx.js';

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
    if (defaultHookAddress !== ZERO_ADDRESS_HEX_32) {
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
    if (requiredHookAddress !== ZERO_ADDRESS_HEX_32) {
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

    // Transfer ownership if the configured owner is different from the signer
    if (!eqAddressRadix(this.signer.getAddress(), config.owner)) {
      const setOwnerTx = await getSetMailboxOwnerTx(
        this.base,
        this.gateway,
        this.signer.getAddress(),
        {
          mailboxAddress: address,
          newOwner: config.owner,
        },
      );
      const ownerReceipt = await this.signer.signAndBroadcast(setOwnerTx);
      allReceipts.push(ownerReceipt);
    }

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
    const defaultIsmAddress = config.defaultIsm.deployed.address;
    const defaultHookAddress = config.defaultHook.deployed.address;
    const requiredHookAddress = config.requiredHook.deployed.address;

    // Extract addresses from current state
    const currentDefaultIsmAddress =
      currentState.config.defaultIsm.deployed.address;
    const currentDefaultHookAddress =
      currentState.config.defaultHook.deployed.address;
    const currentRequiredHookAddress =
      currentState.config.requiredHook.deployed.address;

    // Update default ISM if changed
    if (!eqAddressRadix(currentDefaultIsmAddress, defaultIsmAddress)) {
      const setIsmTx = await getSetMailboxDefaultIsmTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          ismAddress: defaultIsmAddress,
        },
      );
      updateTxs.push({
        annotation: `Update mailbox default ISM to ${defaultIsmAddress}`,
        networkId: this.base.getNetworkId(),
        manifest: setIsmTx,
      });
    }

    // Update default hook if changed
    if (!eqAddressRadix(currentDefaultHookAddress, defaultHookAddress)) {
      const setDefaultHookTx = await getSetMailboxDefaultHookTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          hookAddress: defaultHookAddress,
        },
      );
      updateTxs.push({
        annotation: `Update mailbox default hook to ${defaultHookAddress}`,
        networkId: this.base.getNetworkId(),
        manifest: setDefaultHookTx,
      });
    }

    // Update required hook if changed
    if (!eqAddressRadix(currentRequiredHookAddress, requiredHookAddress)) {
      const setRequiredHookTx = await getSetMailboxRequiredHookTx(
        this.base,
        this.signer.getAddress(),
        {
          mailboxAddress: deployed.address,
          hookAddress: requiredHookAddress,
        },
      );
      updateTxs.push({
        annotation: `Update mailbox required hook to ${requiredHookAddress}`,
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
