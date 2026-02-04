import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';
import { Account } from '../utils/types.js';
import { stringToTransactionManifest } from '../utils/utils.js';

import { RadixWarpPopulate } from './populate.js';

export class RadixWarpTx {
  private account: Account;
  private networkId: number;

  protected base: RadixBase;
  protected populate: RadixWarpPopulate;
  protected signer: RadixBaseSigner;

  constructor(
    account: Account,
    networkId: number,
    base: RadixBase,
    signer: RadixBaseSigner,
    populate: RadixWarpPopulate,
  ) {
    this.account = account;
    this.networkId = networkId;
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

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
  }

  public async createSyntheticToken({
    mailbox,
    name,
    symbol,
    divisibility,
  }: {
    mailbox: string;
    name: string;
    symbol: string;
    divisibility: number;
  }) {
    const transactionManifest = await this.populate.createSyntheticToken({
      from_address: this.account.address,
      mailbox,
      name,
      symbol,
      divisibility,
    });

    const receipt = await this.signer.signAndBroadcast(transactionManifest);

    return this.base.getNewComponent(receipt);
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

  public async setTokenIsm({ token, ism }: { token: string; ism?: string }) {
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

  public async remoteTransfer({
    token,
    destination_domain,
    recipient,
    amount,
    custom_hook_id,
    gas_limit,
    custom_hook_metadata,
    max_fee,
  }: {
    token: string;
    destination_domain: number;
    recipient: string;
    amount: string;
    custom_hook_id: string;
    gas_limit: string;
    custom_hook_metadata: string;
    max_fee: { denom: string; amount: string };
  }) {
    const stringManifest = await this.populate.remoteTransfer({
      from_address: this.account.address,
      token,
      destination_domain,
      recipient,
      amount,
      custom_hook_id,
      gas_limit,
      custom_hook_metadata,
      max_fee,
    });

    const transactionManifest = await stringToTransactionManifest(
      stringManifest,
      this.networkId,
    );

    await this.signer.signAndBroadcast(transactionManifest);
  }
}
