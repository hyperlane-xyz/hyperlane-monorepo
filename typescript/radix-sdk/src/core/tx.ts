import { assert } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { Account, MultisigIsmReq } from '../utils/types.js';

import { RadixCorePopulate } from './populate.js';

export class RadixCoreTx {
  private account: Account;

  protected base: RadixBase;
  protected populate: RadixCorePopulate;
  protected signer: RadixBaseSigner;

  constructor(
    account: Account,
    base: RadixBase,
    signer: RadixBaseSigner,
    populate: RadixCorePopulate,
  ) {
    this.account = account;
    this.base = base;
    this.signer = signer;
    this.populate = populate;
  }

  public async transfer({
    to_address,
    resource_address,
    amount,
  }: {
    to_address: string;
    resource_address: string;
    amount: string;
  }) {
    const metadata = await this.base.getMetadata({
      resource: resource_address,
    });
    assert(
      metadata,
      `resource with address ${resource_address} does not exist`,
    );

    const transactionManifest = await this.base.transfer({
      from_address: this.account.address,
      to_address,
      resource_address,
      amount,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async createMailbox({ domain_id }: { domain_id: number }) {
    const transactionManifest = await this.populate.createMailbox({
      from_address: this.account.address,
      domain_id,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async createMerkleTreeHook({ mailbox }: { mailbox: string }) {
    const transactionManifest = await this.populate.createMerkleTreeHook({
      from_address: this.account.address,
      mailbox,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async createMerkleRootMultisigIsm({
    validators,
    threshold,
  }: MultisigIsmReq) {
    const transactionManifest = await this.populate.createMerkleRootMultisigIsm(
      {
        from_address: this.account.address,
        validators,
        threshold,
      },
    );

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async createMessageIdMultisigIsm({
    validators,
    threshold,
  }: MultisigIsmReq) {
    const transactionManifest = await this.populate.createMessageIdMultisigIsm({
      from_address: this.account.address,
      validators,
      threshold,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async createRoutingIsm({
    routes,
  }: {
    routes: { ismAddress: string; domainId: number }[];
  }) {
    const transactionManifest = await this.populate.createRoutingIsm({
      from_address: this.account.address,
      routes,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async setRoutingIsmRoute({
    ism,
    route,
  }: {
    ism: string;
    route: {
      domainId: number;
      ismAddress: string;
    };
  }) {
    const transactionManifest = await this.populate.setRoutingIsmRoute({
      from_address: this.account.address,
      ism,
      route,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async removeRoutingIsmRoute({
    ism,
    domain,
  }: {
    ism: string;
    domain: number;
  }) {
    const transactionManifest = await this.populate.removeRoutingIsmRoute({
      from_address: this.account.address,
      ism,
      domain,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async setRoutingIsmOwner({
    ism,
    new_owner,
  }: {
    ism: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setRoutingIsmOwner({
      from_address: this.account.address,
      ism,
      new_owner,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async createNoopIsm() {
    const transactionManifest = await this.populate.createNoopIsm({
      from_address: this.account.address,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async createIgp({ denom }: { denom: string }) {
    const transactionManifest = await this.populate.createIgp({
      from_address: this.account.address,
      denom,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async setIgpOwner({
    igp,
    new_owner,
  }: {
    igp: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setIgpOwner({
      from_address: this.account.address,
      igp,
      new_owner,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async setDestinationGasConfig({
    igp,
    destinationGasConfig,
  }: {
    igp: string;
    destinationGasConfig: {
      remoteDomainId: number;
      gasOracle: {
        tokenExchangeRate: string;
        gasPrice: string;
      };
      gasOverhead: string;
    };
  }) {
    const transactionManifest = await this.populate.setDestinationGasConfig({
      from_address: this.account.address,
      igp,
      destinationGasConfig,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async setMailboxOwner({
    mailbox,
    new_owner,
  }: {
    mailbox: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setMailboxOwner({
      from_address: this.account.address,
      mailbox,
      new_owner,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async createValidatorAnnounce({ mailbox }: { mailbox: string }) {
    const transactionManifest = await this.populate.createValidatorAnnounce({
      from_address: this.account.address,
      mailbox,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async setRequiredHook({
    mailbox,
    hook,
  }: {
    mailbox: string;
    hook: string;
  }) {
    const transactionManifest = await this.populate.setRequiredHook({
      from_address: this.account.address,
      mailbox,
      hook,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async setDefaultHook({
    mailbox,
    hook,
  }: {
    mailbox: string;
    hook: string;
  }) {
    const transactionManifest = await this.populate.setDefaultHook({
      from_address: this.account.address,
      mailbox,
      hook,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async setDefaultIsm({
    mailbox,
    ism,
  }: {
    mailbox: string;
    ism: string;
  }) {
    const transactionManifest = await this.populate.setDefaultIsm({
      from_address: this.account.address,
      mailbox,
      ism,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }
}
