import { RadixBase } from '../utils/base.js';
import { RadixSigner } from '../utils/signer.js';
import { Account } from '../utils/types.js';

import { RadixWarpPopulate } from './populate.js';

export class RadixWarpTx {
  private account: Account;

  protected base: RadixBase;
  protected populate: RadixWarpPopulate;
  protected signer: RadixSigner;

  constructor(
    account: Account,
    base: RadixBase,
    signer: RadixSigner,
    populate: RadixWarpPopulate,
  ) {
    this.account = account;
    this.base = base;
    this.signer = signer;
    this.populate = populate;
  }

  public async createCollateralToken({
    mailbox,
    origin_denom,
  }: {
    mailbox: string;
    origin_denom: string;
  }) {
    const transactionManifest = await this.populate.createCollateralToken({
      from_address: this.account.address,
      mailbox,
      origin_denom,
    });

    const intentHashTransactionId =
      await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(intentHashTransactionId);
  }

  public async createSyntheticToken({
    mailbox,
    name,
    symbol,
    description,
    divisibility,
  }: {
    mailbox: string;
    name: string;
    symbol: string;
    description: string;
    divisibility: number;
  }) {
    const transactionManifest = await this.populate.createSyntheticToken({
      from_address: this.account.address,
      mailbox,
      name,
      symbol,
      description,
      divisibility,
    });

    const intentHashTransactionId =
      await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(intentHashTransactionId);
  }

  public async setTokenOwner({
    token,
    new_owner,
  }: {
    token: string;
    new_owner: string;
  }) {
    const transactionManifest = await this.populate.setTokenOwner({
      from_address: this.account.address,
      token,
      new_owner,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async setTokenIsm({ token, ism }: { token: string; ism: string }) {
    const transactionManifest = await this.populate.setTokenIsm({
      from_address: this.account.address,
      token,
      ism,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async enrollRemoteRouter({
    token,
    receiver_domain,
    receiver_address,
    gas,
  }: {
    token: string;
    receiver_domain: number;
    receiver_address: string;
    gas: string;
  }) {
    const transactionManifest = await this.populate.enrollRemoteRouter({
      from_address: this.account.address,
      token,
      receiver_domain,
      receiver_address,
      gas,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }

  public async unenrollRemoteRouter({
    token,
    receiver_domain,
  }: {
    token: string;
    receiver_domain: number;
  }) {
    const transactionManifest = await this.populate.unenrollRemoteRouter({
      from_address: this.account.address,
      token,
      receiver_domain,
    });

    await this.signer.signAndBroadcast(transactionManifest);
  }
}
